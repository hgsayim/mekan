import { mkdir, rm, writeFile, copyFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const DIST_DIR = 'dist';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

function warnMissing(name) {
  console.warn(
    `[build] Missing env var ${name}. ` +
      `Build will continue and app will fall back to values in supabase-config.js. ` +
      `For Cloudflare Pages, set ${name} in Project Settings -> Environment variables (Production/Preview as needed).`
  );
}

if (!SUPABASE_URL) warnMissing('SUPABASE_URL');
if (!SUPABASE_ANON_KEY) warnMissing('SUPABASE_ANON_KEY');

await rm(DIST_DIR, { recursive: true, force: true });
await mkdir(DIST_DIR, { recursive: true });

// Copy all top-level project files we serve (keep it explicit to avoid shipping notes/docs)
const FILES = [
  'index.html',
  'styles.css',
  'app.js',
  'database.js',
  'hybrid-db.js',
  'supabase-db.js',
  'supabase-config.js',
  'service-worker.js',
  'manifest.json',
  'icon.svg',
];

for (const f of FILES) {
  await copyFile(f, join(DIST_DIR, f));
}

// Copy src/utils directory (required by app.js imports)
const srcUtilsDir = join(DIST_DIR, 'src', 'utils');
await mkdir(srcUtilsDir, { recursive: true });
const utilsFiles = ['performance.js', 'formatters.js', 'calculators.js'];
for (const f of utilsFiles) {
  await copyFile(join('src', 'utils', f), join(srcUtilsDir, f));
}

// Generate env.js (loaded before app.js). Safe: anon key is public; still nicer not to commit.
const envJs = `// Generated at build time by build.mjs (Cloudflare Pages env vars)
window.__MEKANAPP_ENV__ = {
  SUPABASE_URL: ${JSON.stringify(SUPABASE_URL)},
  SUPABASE_ANON_KEY: ${JSON.stringify(SUPABASE_ANON_KEY)}
};
`;

await writeFile(join(DIST_DIR, 'env.js'), envJs, 'utf8');

