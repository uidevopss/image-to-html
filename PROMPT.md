# Improved prompt

## Your original request, rewritten (use this to brief a developer or an AI coder)

**Role:** Act as a senior front-end developer.

**Goal:** Build a React (Vite) single-page app that converts an uploaded design image plus a text instruction into a production-ready, responsive HTML email template using the Gemini API.

**App requirements**
1. Inputs: image upload (drag-drop, browse, paste), a free-text instruction, a Gemini API key field (kept in the browser only) and a model selector.
2. Call Gemini (`generateContent`) with the image and a system prompt. Request structured JSON output: `html`, `images[]` (id, `box_2d` [ymin,xmin,ymax,xmax] on a 0-1000 scale, display_width, format), `notes[]`.
3. In the HTML, Gemini marks every non-text visual with `src="{{img:ID}}"`. The app crops each box from the original upload on a canvas and replaces the placeholder with an embedded base64 data URI, so the final file is self-contained.
4. Output: live preview (desktop and 375px mobile), HTML source tab, cropped-image gallery, copy and download buttons, an automatic rule checker, and a "refine" box for follow-up edits.
5. Handle errors: missing key, API errors, invalid or truncated JSON, bad boxes, missing placeholders.

**Email rules the generated HTML must obey**
1. Table-based layout only (no div).
2. Inline CSS only (optionally one media-query block for stacking, toggleable).
3. No modern CSS (flex, grid, var, calc, float, position, web fonts, svg).
4. 600px max width, fluid-hybrid pattern with an Outlook (MSO) ghost table.
5. Images are cropped from the uploaded design and embedded in the HTML.
6. Gemini does all generation and analysis.

**Acceptance criteria:** renders correctly in Gmail, Outlook and Apple Mail; every `<img>` has alt, width, height; no unresolved placeholders; colours and text match the source image.

## The prompt actually sent to Gemini
It lives in `src/prompt.js` (`buildSystemPrompt`). Key improvements over the original six bullet points:
- Defines a role and a clear task/priority order (hard rules beat the user instruction).
- Spells out the email-client constraints: MSO ghost table, bulletproof buttons, spacer rows, web-safe fonts, preheader, doctype and meta tags.
- Gives an explicit list of forbidden and allowed CSS instead of "no modern CSS".
- Solves the cropping problem with a placeholder + normalised bounding-box contract, with rules for what to crop and what to rebuild as text.
- Forces structured JSON output (response schema) so the app can parse it reliably.
- Adds a silent self-check list, and a `notes` field for assumptions.

## Configuration
Copy `.env.example` to `.env`, set `VITE_GEMINI_API_KEY` (and optionally `VITE_GEMINI_MODEL`), then restart `npm run dev`.
Vite inlines `VITE_*` variables into the browser bundle, so the key is visible to anyone who can load the app. Use this for local or personal use only; for a public deployment, proxy Gemini through a backend.
