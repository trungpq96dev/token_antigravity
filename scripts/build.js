const fs = require('fs');
const path = require('path');
const { collectLocalAntigravityTelemetry } = require('../server');

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

const STATIC_FILES = [
  'index.html',
  'ui-mockup.png',
  'README.md',
  'vercel.json',
  'netlify.toml',
];

function build() {
  if (fs.existsSync(DIST_DIR)) {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(DIST_DIR, { recursive: true });

  const builtFiles = [];

  for (const file of STATIC_FILES) {
    const src = path.join(ROOT_DIR, file);
    const dest = path.join(DIST_DIR, file);
    if (!fs.existsSync(src)) {
      throw new Error(`Missing required source file: ${file}`);
    }
    fs.copyFileSync(src, dest);
    const { size } = fs.statSync(dest);
    builtFiles.push({ file, size });
  }

  // Generate static fallback telemetry snapshot for static hosting
  const telemetry = collectLocalAntigravityTelemetry();
  const snapshot = {
    source: 'static-snapshot',
    name: telemetry.name,
    email: 'local@antigravity.dev',
    plan: telemetry.plan,
    max: telemetry.max,
    used: telemetry.used,
    remaining: telemetry.remaining,
    resetDays: telemetry.resetDays,
    tasks: telemetry.tasks,
    trend: telemetry.trend,
    trendLabels: telemetry.trendLabels,
    history: telemetry.history,
    syncedAt: new Date().toISOString(),
  };

  const fallbackPath = path.join(DIST_DIR, 'api-fallback.json');
  fs.writeFileSync(fallbackPath, JSON.stringify(snapshot, null, 2), 'utf8');
  builtFiles.push({ file: 'api-fallback.json', size: fs.statSync(fallbackPath).size });

  console.log('Build completed -> dist/');
  for (const entry of builtFiles) {
    console.log(`  - ${entry.file} (${(entry.size / 1024).toFixed(1)} KB)`);
  }
}

build();
