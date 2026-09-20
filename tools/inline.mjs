/**
 * Fold `vite build` output into ONE self-contained .html file.
 *
 * The point is a build that runs on a machine with NOTHING installed — no Node, no server, not even
 * a file server. Double-clicking the result opens a working jar.
 *
 * Two facts make this safe, and both are worth checking if the build config ever changes:
 *
 * 1. The bundle compiles to a self-contained IIFE with no `import`/`export` left, so it does not
 *    need a module loader. Inlining it as a plain <script> is therefore lossless. This is NOT true
 *    of Vite output in general — it holds here because the app is one entry with no code splitting.
 * 2. `type="module"` implies `defer`; a plain inline <script> does NOT. Left in <head> it would run
 *    before #stage is parsed and die on `getContext`. Hence the script goes last in <body>.
 *
 * Absolute `/assets/...` URLs stop mattering once nothing is fetched at all, which is why this needs
 * no `base: './'` in vite.config.ts.
 *
 * Usage: node tools/inline.mjs [distDir]
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dist = process.argv[2] ?? 'dist';

let assets;
try {
  assets = readdirSync(join(dist, 'assets'));
} catch {
  console.error(`No ${join(dist, 'assets')}. Run \`npm run build\` first.`);
  process.exit(1);
}

const js = assets.find((f) => f.endsWith('.js'));
const css = assets.find((f) => f.endsWith('.css'));
if (!js) {
  console.error(`No .js bundle in ${join(dist, 'assets')}.`);
  process.exit(1);
}

const read = (f) => readFileSync(join(dist, 'assets', f), 'utf8');

/**
 * Audio has to be folded in as base64, because there is nothing to fetch it from.
 *
 * The bundle refers to each track as `/assets/Name-hash.mp3`; those references are rewritten to
 * `data:` URIs here. It is the one heavy thing in the build — base64 costs a third on top of the
 * file's own size — so the single-file copy is tens of megabytes where the game itself is ~140 kB.
 * That is the price of a jar that plays music with nothing installed and no network.
 */
function inlineAudio(code) {
  let out = code;
  for (const f of assets.filter((a) => a.endsWith('.mp3'))) {
    const b64 = readFileSync(join(dist, 'assets', f)).toString('base64');
    out = out.split(`/assets/${f}`).join(`data:audio/mpeg;base64,${b64}`);
  }
  return out;
}

const code = inlineAudio(read(js));

// Guard fact (1) above rather than trusting it: a split build would silently produce a dead page.
if (/(^|\n)\s*(import|export)\s/.test(code) || /\bimport\s*\(/.test(code)) {
  console.error('Bundle still uses module syntax — inlining it as a plain script would break it.');
  process.exit(1);
}

let html = readFileSync(join(dist, 'index.html'), 'utf8');
html = html.replace(/[ \t]*<script\b[^>]*\bsrc="[^"]*"[^>]*><\/script>\r?\n?/g, '');
html = html.replace(/[ \t]*<link\b[^>]*\bstylesheet[^>]*>\r?\n?/g, '');
if (css) html = html.replace('</head>', `  <style>\n${read(css)}\n  </style>\n  </head>`);
html = html.replace('</body>', `  <script>\n${code}\n  </script>\n  </body>`);

if (html.includes('/assets/')) {
  console.error('An /assets/ reference survived — the file would not be self-contained.');
  process.exit(1);
}

const out = join(dist, 'terrapixel.html');
writeFileSync(out, html);
console.log(`${out} — ${(Buffer.byteLength(html) / 1024).toFixed(0)} kB, needs only a browser`);
