// Builds the extension into an output folder (default: dist/).
// Usage: node scripts/build.mjs [--out dist] [--ebs https://ebs.example.com] [--dev]
// JS is bundled per view with esbuild as a readable (NOT minified) IIFE, no source maps,
// so it is human-readable for Twitch review (guideline 2.5) and has no runtime module loading.
import { build } from 'esbuild';
import { rm, mkdir, cp, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VIEWS = ['panel', 'video_overlay', 'video_component', 'config', 'live_config'];

export async function buildExtension({ outDir, ebsBaseUrl, dev = false, keepAliveMs }) {
  // keepAliveMs override is for the dev harness/e2e only; production always uses 5 minutes.
  const keepAlive = dev && keepAliveMs > 0 ? keepAliveMs : 5 * 60_000;
  if (!ebsBaseUrl) throw new Error('EBS base URL is required');
  if (!dev && !/^https:\/\/[^/]+/.test(ebsBaseUrl)) {
    throw new Error(`Production EBS_BASE_URL must be https:// (got "${ebsBaseUrl}")`);
  }
  await rm(outDir, { recursive: true, force: true });
  await mkdir(path.join(outDir, 'js'), { recursive: true });
  await build({
    entryPoints: Object.fromEntries(VIEWS.map((v) => [v, path.join(ROOT, 'src/js', `${v}.entry.js`)])),
    outdir: path.join(outDir, 'js'),
    bundle: true,
    format: 'iife',
    target: ['es2019'],
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    charset: 'utf8',
    define: { __EBS_BASE_URL__: JSON.stringify(ebsBaseUrl.replace(/\/+$/, '')), __DEV_BUILD__: dev ? 'true' : 'false', __KEEPALIVE_MS__: String(keepAlive) },
    logLevel: 'warning',
  });
  await cp(path.join(ROOT, 'src/css'), path.join(outDir, 'css'), { recursive: true });
  await cp(path.join(ROOT, 'src/img'), path.join(outDir, 'img'), { recursive: true });
  for (const f of await readdir(path.join(ROOT, 'src'))) {
    if (f.endsWith('.html')) await cp(path.join(ROOT, 'src', f), path.join(outDir, f));
  }
  return outDir;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = (k) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dev = args.includes('--dev');
  const outDir = path.resolve(ROOT, get('--out') || 'dist');
  const ebsBaseUrl = get('--ebs') || process.env.EBS_BASE_URL || (dev ? 'http://localhost:8090' : undefined);
  buildExtension({ outDir, ebsBaseUrl, dev })
    .then(() => console.log(`Built ${path.relative(ROOT, outDir)}/ (EBS_BASE_URL=${ebsBaseUrl})`))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
