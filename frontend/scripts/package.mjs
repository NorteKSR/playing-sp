// Production package for Twitch "Upload Version Assets".
//   EBS_BASE_URL=https://ebs.example.com npm run package
// → builds dist/, validates it against Twitch rules, writes release/now-playing-frontend-<version>.zip
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExtension, VIEWS } from './build.mjs';
import { createZip } from './zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const HELPER = 'https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js';
const ALLOWED_EXT = new Set(['.html', '.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.woff2']);
const MOBILE_BUDGET = 1024 * 1024;
// Official Spotify full-logo files, byte-identical to 2024-spotify-full-logo.zip from
// https://developer.spotify.com/documentation/design ("no modification" rule). Build fails if they change.
export const SPOTIFY_LOGO_SHA256 = {
  'img/spotify/Full_Logo_Green_RGB.svg': '6e01367cde4cb752b11fd9250becc4a579d1f40bdddaaf23522f27aaa5cf8d70',
  'img/spotify/Full_Logo_White_RGB.svg': '31cdfcdd58d3533a32d287267a1c404f376749b1fc4da99e4baa2233684f053c',
}; // guideline 3.2: mobile initial load from Twitch CDN ≤ 1 MB

async function walk(dir, base = dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

export async function validateDist(dir) {
  const errors = [];
  const files = await walk(dir);
  for (const view of VIEWS) if (!files.includes(`${view}.html`)) errors.push(`missing ${view}.html at root`);
  for (const [f, sum] of Object.entries(SPOTIFY_LOGO_SHA256)) {
    if (!files.includes(f)) { errors.push(`missing official Spotify logo ${f}`); continue; }
    const got = crypto.createHash('sha256').update(await readFile(path.join(dir, f))).digest('hex');
    if (got !== sum) errors.push(`${f} differs from the official Spotify asset (sha256 ${got})`);
  }
  for (const f of files) {
    if (/\s/.test(f)) errors.push(`file name contains whitespace: ${f}`);
    if (!ALLOWED_EXT.has(path.extname(f).toLowerCase())) errors.push(`disallowed file type: ${f}`);
    if (/(^|\/)(dev|test|node_modules)\//.test(f) || /mock/i.test(f)) errors.push(`dev/mock file in package: ${f}`);
    const text = /\.(html|js|css)$/.test(f) ? await readFile(path.join(dir, f), 'utf8') : '';
    if (/sourceMappingURL/.test(text) || f.endsWith('.map')) errors.push(`source map reference: ${f}`);
    if (/__mockTwitch|__dev\/|mock-twitch-ext|localhost/.test(text)) errors.push(`dev/mock reference in ${f}`);
    if (f.endsWith('.js') && (/\beval\s*\(/.test(text) || /new\s+Function\s*\(/.test(text))) errors.push(`eval/new Function in ${f}`);
    if (f.endsWith('.html')) {
      const scripts = [...text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
      if (!scripts.length || !scripts[0][1].includes(`src="${HELPER}"`)) errors.push(`${f}: helper is not the first script`);
      for (const s of scripts) {
        if (!/\ssrc=/.test(s[1]) || s[2].trim()) errors.push(`${f}: inline script not allowed by Twitch CSP`);
        const src = (/\ssrc="([^"]+)"/.exec(s[1]) || [])[1];
        if (src && src !== HELPER && /^(https?:)?\/\//.test(src)) errors.push(`${f}: remote script ${src}`);
        if (src && src.startsWith('/')) errors.push(`${f}: absolute path ${src} (use relative paths)`);
      }
      if (/\son[a-z]+\s*=/i.test(text)) errors.push(`${f}: inline event handler attribute`);
      for (const m of text.matchAll(/<link\b[^>]*href="([^"]+)"/gi)) {
        if (/^(https?:)?\/\//.test(m[1]) || m[1].startsWith('/')) errors.push(`${f}: non-relative stylesheet ${m[1]}`);
      }
    }
  }
  return { files, errors };
}

async function main() {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const ebs = process.env.EBS_BASE_URL;
  if (!ebs) {
    console.error('Set EBS_BASE_URL, e.g. EBS_BASE_URL=https://ebs.example.com npm run package');
    process.exit(1);
  }
  await buildExtension({ outDir: DIST, ebsBaseUrl: ebs });
  const { files, errors } = await validateDist(DIST);
  if (errors.length) {
    console.error('Package validation FAILED:\n  - ' + errors.join('\n  - '));
    process.exit(1);
  }
  const entries = [];
  let raw = 0;
  for (const f of files) {
    const data = await readFile(path.join(DIST, f));
    raw += data.length;
    entries.push({ name: f, data });
  }
  const zip = createZip(entries);
  await mkdir(path.join(ROOT, 'release'), { recursive: true });
  const out = path.join(ROOT, 'release', `now-playing-frontend-${pkg.version}.zip`);
  await writeFile(out, zip);
  const perView = {};
  for (const v of VIEWS) {
    const html = (await stat(path.join(DIST, `${v}.html`))).size;
    const js = (await stat(path.join(DIST, 'js', `${v}.js`))).size;
    const css = (await stat(path.join(DIST, 'css/common.css'))).size + (await stat(path.join(DIST, 'css', v.includes('config') ? 'config.css' : 'viewer.css'))).size
      + (await stat(path.join(DIST, 'img/spotify/Full_Logo_White_RGB.svg'))).size + (await stat(path.join(DIST, 'img/spotify/Full_Logo_Green_RGB.svg'))).size;
    perView[v] = html + js + css;
  }
  console.log(`EBS_BASE_URL: ${ebs}`);
  console.log(`Files (${files.length}):\n  ${files.join('\n  ')}`);
  console.log(`Uncompressed: ${(raw / 1024).toFixed(1)} KB   Zip: ${(zip.length / 1024).toFixed(1)} KB → ${path.relative(ROOT, out)}`);
  for (const [v, b] of Object.entries(perView)) {
    console.log(`  initial load ${v}: ${(b / 1024).toFixed(1)} KB (mobile budget 1024 KB)${b > MOBILE_BUDGET ? '  ⚠ OVER' : ''}`);
  }
  console.log('Validation: OK (helper first, no inline/remote scripts, no eval, no source maps, no mock code, relative paths, official Spotify logos unmodified)');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e); process.exit(1); });
