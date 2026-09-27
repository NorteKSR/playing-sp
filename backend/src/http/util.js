import crypto from 'node:crypto';
export const CONTRACT_VERSION = 1;

export class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

export function sendError(res, err) {
  sendJson(res, err.status, { version: CONTRACT_VERSION, error: { code: err.code, message: err.message } }, err.headers);
}

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * OAuth callback result page, shown in the popup the config view opened with window.open().
 * - Posts {type:"spotify_link_result", version, ok, reason} to window.opener (if the opener was kept) for each
 *   allowed origin (postMessage silently drops mismatching targetOrigins; the message contains no secrets).
 * - Closes itself (success after closeAfterMs, failure after a longer delay so the reason can be read).
 * - If the browser refuses window.close(), shows a "you can close this window" fallback + a Close button.
 * CSP: per-response nonce, no inline handlers.
 */
export function sendCallbackPage(res, status, { title, message, ok, reason = null, postMessageOrigins = [], closeAfterMs }) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const delay = closeAfterMs ?? (ok ? 1500 : 10000);
  const data = JSON.stringify({ msg: { type: 'spotify_link_result', version: CONTRACT_VERSION, ok, reason }, origins: postMessageOrigins.filter((o) => o !== '*'), delay }).replace(/</g, '\\u003c');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)}</title>
<style nonce="${nonce}">body{font-family:system-ui,sans-serif;background:#18181b;color:#efeff1;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}main{max-width:32rem;padding:2rem;text-align:center}h1{font-size:1.4rem}#fallback{color:#adadb8}button{margin-top:1rem;padding:.5rem 1.2rem;border-radius:4px;border:0;background:#9147ff;color:#fff;font-size:1rem;cursor:pointer}</style></head>
<body><main data-ok="${ok ? 'true' : 'false'}"><h1>${escHtml(title)}</h1><p>${escHtml(message)}</p>
<p id="countdown">${ok ? 'This window will close automatically.' : `This window will close in ${Math.round(delay / 1000)} seconds.`}</p>
<p id="fallback" hidden>You can close this window now and return to the extension configuration.</p>
<button id="close" type="button">Close window</button></main>
<script id="result" type="application/json">${data}</script>
<script nonce="${nonce}">(function(){var d=JSON.parse(document.getElementById('result').textContent);
try{if(window.opener&&!window.opener.closed){d.origins.forEach(function(o){try{window.opener.postMessage(d.msg,o)}catch(e){}})}}catch(e){}
function tryClose(){try{window.close()}catch(e){}setTimeout(function(){if(!window.closed){document.getElementById('countdown').hidden=true;document.getElementById('fallback').hidden=false}},300)}
document.getElementById('close').addEventListener('click',tryClose);setTimeout(tryClose,d.delay)})();</script></body></html>`;
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(html);
}

export async function readJsonBody(req, limit = 16 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'bad_request', 'Body too large');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_request', 'Invalid JSON body');
  }
}

/** Fixed-window in-memory rate limiter. */
export class RateLimiter {
  constructor({ perMinute = 120, now = () => Date.now() } = {}) {
    this.perMinute = perMinute;
    this.now = now;
    this.windows = new Map();
  }
  check(key) {
    const t = this.now();
    const win = Math.floor(t / 60000);
    let w = this.windows.get(key);
    if (!w || w.win !== win) {
      w = { win, count: 0 };
      this.windows.set(key, w);
      if (this.windows.size > 50000) this.windows.clear();
    }
    w.count++;
    if (w.count > this.perMinute) {
      throw new HttpError(429, 'rate_limited', 'Too many requests', { 'Retry-After': String(60 - Math.floor((t % 60000) / 1000)) });
    }
  }
}
