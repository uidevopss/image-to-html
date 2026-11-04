import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { generateTemplate } from './gemini.js';
import {
  fileToDataUrl,
  loadImage,
  prepareForGemini,
  cropAll,
  assembleHtml,
  runChecks,
} from './imageTools.js';

const DEFAULT_MODEL = 'gemini-2.5-flash';
// Set these in .env (see .env.example). Vite exposes only VITE_-prefixed variables.
const ENV_KEY = (import.meta.env.VITE_GEMINI_API_KEY || '').trim();
const ENV_MODEL = (import.meta.env.VITE_GEMINI_MODEL || '').trim();
const store = {
  get: (k, d = '') => {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

export default function App() {
  const apiKey = ENV_KEY;
  const model = ENV_MODEL || DEFAULT_MODEL;
  const fallbackModels = (import.meta.env.VITE_GEMINI_FALLBACK_MODELS ?? 'gemini-2.0-flash')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

  const [imageUrl, setImageUrl] = useState(null);
  const [imageEl, setImageEl] = useState(null);
  const [instruction, setInstruction] = useState('');
  const [refine, setRefine] = useState('');

  const [template, setTemplate] = useState('');
  const [crops, setCrops] = useState([]);
  const [notes, setNotes] = useState([]);
  const [warnings, setWarnings] = useState([]);

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [tab, setTab] = useState('preview');
  const [viewport, setViewport] = useState('desktop');
  const [copied, setCopied] = useState(false);
  const abortRef = useRef(null);


  const finalHtml = useMemo(() => (template ? assembleHtml(template, crops).html : ''), [template, crops]);
  const checks = useMemo(() => (finalHtml ? runChecks(finalHtml) : []), [finalHtml]);

  const loadFile = useCallback(async (file) => {
    if (!file || !file.type.startsWith('image/')) {
      setError('Please choose an image file (PNG, JPG, WebP).');
      return;
    }
    setError('');
    try {
      const url = await fileToDataUrl(file);
      const el = await loadImage(url);
      setImageUrl(url);
      setImageEl(el);
      setTemplate('');
      setCrops([]);
      setNotes([]);
      setWarnings([]);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  // Paste support (Ctrl/Cmd+V a screenshot)
  useEffect(() => {
    const onPaste = (e) => {
      const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
      if (f) loadFile(f);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [loadFile]);

  async function run(isRefine) {
    if (!apiKey.trim())
      return setError('No Gemini API key. Add VITE_GEMINI_API_KEY to .env and restart the dev server.');
    if (!imageEl) return setError('Upload a design image first.');
    setError('');
    setBusy(true);
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const result = await generateTemplate({
        apiKey: apiKey.trim(),
        model,
        fallbackModels,
        onStatus: setStatus,
        image: prepareForGemini(imageEl),
        instruction: isRefine ? refine : instruction,
        allowMediaQuery: true, // always on; not exposed in the UI
        previousHtml: isRefine ? template : undefined,
        signal: ctrl.signal,
      });
      const { crops: newCrops, errors } = cropAll(imageEl, result.images);
      const { missing } = assembleHtml(result.html, newCrops);
      setTemplate(result.html);
      setCrops(newCrops);
      setNotes(result.notes);
      setWarnings([
        ...(result.modelUsed && result.modelUsed !== model
          ? [`${model} was busy, so this template was generated with ${result.modelUsed}.`]
          : []),
        ...errors,
        ...missing.map((id) => `No crop was returned for "${id}" - a placeholder image is shown.`),
      ]);
      if (isRefine) setRefine('');
      setTab('preview');
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message);
    } finally {
      setBusy(false);
      setStatus('');
    }
  }

  function download(name, content, type) {
    const blob = new Blob([content], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function copyHtml() {
    try {
      await navigator.clipboard.writeText(finalHtml);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Copy failed - use Download instead.');
    }
  }

  return (
    <div className="app">
      <header className="top">
        <h1>Image → Email Template</h1>
        <p>Upload a design, describe changes, get a table-based responsive HTML email (600px, inline CSS) built with Gemini.</p>
      </header>

      <main className="grid">
        <section className="panel">
          {!ENV_KEY && (
            <div className="alert error">
              Missing <code>VITE_GEMINI_API_KEY</code>. Create a <code>.env</code> file in the project root (see{' '}
              <code>.env.example</code>) and restart <code>npm run dev</code>.
            </div>
          )}

          <h2>1. Design image</h2>
          <Dropzone onFile={loadFile} imageUrl={imageUrl} />

          <h2>2. Instruction</h2>
          <textarea
            rows={5}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="Optional. e.g. Brand colour is #0A5CFF. Keep the hero image, make the CTA say 'Shop now', add a footer with unsubscribe link."
          />
          <button className="primary" disabled={busy || !imageEl} onClick={() => run(false)}>
            {busy ? 'Generating Email Template....' : template ? 'Regenerate from scratch' : 'Generate email template'}
          </button>
          {busy && (
            <button className="ghost" onClick={() => abortRef.current?.abort()}>
              Cancel
            </button>
          )}
          {error && <div className="alert error">{error}</div>}
        </section>

        <section className="panel wide">
          <div className="bar">
            <div className="tabs">
              <button className={tab === 'preview' ? 'on' : ''} onClick={() => setTab('preview')}>
                Preview
              </button>
              <button className={tab === 'code' ? 'on' : ''} onClick={() => setTab('code')}>
                HTML
              </button>
              <button className={tab === 'assets' ? 'on' : ''} onClick={() => setTab('assets')}>
                Cropped images ({crops.length})
              </button>
            </div>
            {tab === 'preview' && (
              <div className="tabs">
                <button className={viewport === 'desktop' ? 'on' : ''} onClick={() => setViewport('desktop')}>
                  Desktop
                </button>
                <button className={viewport === 'mobile' ? 'on' : ''} onClick={() => setViewport('mobile')}>
                  Mobile 375
                </button>
              </div>
            )}
            <div className="tabs">
              <button disabled={!finalHtml} onClick={copyHtml}>
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button disabled={!finalHtml} onClick={() => download('email-template.html', finalHtml, 'text/html')}>
                Download .html
              </button>
            </div>
          </div>

          {!finalHtml && (
            <div className="empty">
              {busy ? 'Gemini is building your template…' : 'Your template will appear here.'}
            </div>
          )}

          {finalHtml && tab === 'preview' && (
            <div className="stage">
              <iframe
                title="Email preview"
                sandbox=""
                srcDoc={finalHtml}
                style={{ width: viewport === 'mobile' ? 375 : '100%' }}
              />
            </div>
          )}
          {finalHtml && tab === 'code' && <pre className="code">{finalHtml}</pre>}
          {finalHtml && tab === 'assets' && (
            <div className="assets">
              {crops.map((c) => (
                <figure key={c.id}>
                  <img src={c.dataUrl} alt={c.description || c.id} />
                  <figcaption>
                    <b>{c.id}</b> · {c.width}×{c.height} · {c.mime.split('/')[1]}
                    <br />
                    <button
                      className="link"
                      onClick={() => download(`${c.id}.${c.mime === 'image/png' ? 'png' : 'jpg'}`, dataUrlToBlob(c.dataUrl), c.mime)}
                    >
                      Download
                    </button>
                  </figcaption>
                </figure>
              ))}
              {!crops.length && <p className="muted">No images were cropped for this design.</p>}
            </div>
          )}

          {finalHtml && (
            <>
              <ul className="checks">
                {checks.map((c) => (
                  <li key={c.label} className={c.ok ? 'ok' : c.warn ? 'warn' : 'bad'}>
                    {c.ok ? '✓' : c.warn ? '!' : '✕'} {c.label}
                  </li>
                ))}
              </ul>
              {[...warnings, ...notes].length > 0 && (
                <div className="alert note">
                  <b>Review:</b>
                  <ul>
                    {warnings.map((w, i) => (
                      <li key={'w' + i}>{w}</li>
                    ))}
                    {notes.map((n, i) => (
                      <li key={'n' + i}>{n}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="refine">
                <input
                  value={refine}
                  placeholder="Refine: e.g. make the button larger and use #E4572E"
                  onChange={(e) => setRefine(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && refine.trim() && !busy && run(true)}
                />
                <button className="primary" disabled={busy || !refine.trim()} onClick={() => run(true)}>
                  {busy ? '…' : 'Apply'}
                </button>
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}

function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const mime = head.match(/:(.*?);/)[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function Dropzone({ onFile, imageUrl }) {
  const [over, setOver] = useState(false);
  const inputRef = useRef(null);
  return (
    <div
      className={'drop' + (over ? ' over' : '')}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onFile(e.dataTransfer.files?.[0]);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => onFile(e.target.files?.[0])}
      />
      {imageUrl ? (
        <img src={imageUrl} alt="Uploaded design" />
      ) : (
        <p>Drop an image here, click to browse, or paste a screenshot (Ctrl/Cmd+V)</p>
      )}
    </div>
  );
}
