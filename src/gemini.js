import { buildSystemPrompt, buildUserPrompt, RESPONSE_SCHEMA } from './prompt.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

// Retry settings for temporary overload (HTTP 429 / 500 / 502 / 503 / 504)
const ATTEMPTS_PER_MODEL = 2; // 1 try + 1 quick retry, then move to the next model
const BASE_DELAY_MS = 1000;
// A request that hangs longer than this is abandoned and treated as "busy".
const REQUEST_TIMEOUT_MS = Number(import.meta.env.VITE_GEMINI_TIMEOUT_MS) || 60000;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

// Fallbacks tried in order when the main model is overloaded. Extra ones can be added in .env:
// VITE_GEMINI_FALLBACK_MODELS=gemini-2.5-pro  (blank or missing is fine, built-in ones are always used)
const BUILT_IN_FALLBACKS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
const ENV_FALLBACKS = (import.meta.env.VITE_GEMINI_FALLBACK_MODELS || '')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}

async function callModel({ apiKey, model, body, signal }) {
  // Own controller so we can enforce a timeout and still honour the user's Cancel button.
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, REQUEST_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  let res;
  let data;
  try {
    res = await fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    if (timedOut && !signal?.aborted) {
      const err = new Error(`${model} did not respond within ${REQUEST_TIMEOUT_MS / 1000}s`);
      err.status = 504;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Gemini request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function parseResponse(data) {
  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) {
    throw new Error(
      data?.promptFeedback?.blockReason
        ? `Blocked by Gemini: ${data.promptFeedback.blockReason}`
        : `Empty response from Gemini (finishReason: ${cand?.finishReason || 'unknown'})`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error(
        cand?.finishReason === 'MAX_TOKENS'
          ? 'Response was cut off (too long). Try a simpler image or a model with a larger output limit.'
          : 'Gemini returned invalid JSON. Please try again.'
      );
    }
  }
  if (!parsed.html) throw new Error('Gemini response did not include any HTML.');
  parsed.images = Array.isArray(parsed.images) ? parsed.images : [];
  parsed.notes = Array.isArray(parsed.notes) ? parsed.notes : [];
  return parsed;
}

export async function generateTemplate({
  apiKey,
  model,
  image, // { base64, mime, width, height }
  instruction,
  allowMediaQuery,
  previousHtml,
  signal,
  onStatus = () => {},
}) {
  const body = {
    systemInstruction: { parts: [{ text: buildSystemPrompt({ allowMediaQuery }) }] },
    contents: [
      {
        role: 'user',
        parts: [
          { inline_data: { mime_type: image.mime, data: image.base64 } },
          {
            text: buildUserPrompt({
              instruction,
              width: image.width,
              height: image.height,
              previousHtml,
            }),
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      maxOutputTokens: 32768,
    },
  };

  const models = [...new Set([model, ...ENV_FALLBACKS, ...BUILT_IN_FALLBACKS])];
  let lastError;

  for (let m = 0; m < models.length; m++) {
    const current = models[m];
    for (let attempt = 1; attempt <= ATTEMPTS_PER_MODEL; attempt++) {
      try {
        onStatus(
          m === 0 && attempt === 1
            ? `Generating with ${current}…`
            : `Generating with ${current} (attempt ${attempt}/${ATTEMPTS_PER_MODEL})…`
        );
        const data = await callModel({ apiKey, model: current, body, signal });
        const result = parseResponse(data);
        result.modelUsed = current;
        return result;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        lastError = e;
        // Unknown model name: skip straight to the next fallback.
        if (e.status === 404) break;
        // Not a temporary problem (bad key, bad request, blocked content, bad JSON): stop.
        if (!RETRYABLE.has(e.status)) throw e;
        if (attempt < ATTEMPTS_PER_MODEL) {
          const wait = BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 500;
          onStatus(`${current} is busy. Retrying in ${Math.ceil(wait / 1000)}s…`);
          await sleep(wait, signal);
        }
      }
    }
    if (m < models.length - 1) onStatus(`${current} is still busy. Switching to ${models[m + 1]}…`);
  }

  throw new Error(
    `All Gemini models are busy right now (${models.join(', ')}). ${lastError?.message || ''} Please try again in a minute.`.trim()
  );
}
