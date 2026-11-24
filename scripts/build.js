const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

const STATIC_FILES = [
  'index.html',
  'ui-mockup.png',
  'README.md',
  'vercel.json',
  'netlify.toml',
];

function createAnonymizedFallback() {
  return {
    source: 'demo-snapshot',
    name: 'Local Antigravity IDE',
    email: 'local@antigravity.dev',
    plan: 'Pro Plan',
    max: 2000000,
    used: 579500,
    remaining: 1420500,
    resetDays: 6,
    tasks: {
      agent: 380000,
      auto: 145000,
      chat: 54500,
    },
    trend: [55, 78, 46, 62, 28, 52, 85],
    trendLabels: ['T4', 'T5', 'T6', 'T7', 'CN', 'T2', 'Today'],
    history: [
      {
        id: 'tx-demo-1',
        title: 'Agent Refactor Session',
        taskType: 'Agent & Reasoning',
        delta: -142000,
        timestamp: '2026-11-24T01:00:00.000Z',
        source: 'Demo Snapshot',
      },
      {
        id: 'tx-demo-2',
        title: 'Inline Code Completion',
        taskType: 'Code Autocomplete',
        delta: -48500,
        timestamp: '2026-11-23T18:30:00.000Z',
        source: 'Demo Snapshot',
      },
      {
        id: 'tx-demo-3',
        title: 'Monthly Quota Allocation',
        taskType: 'Top-up',
        delta: 2000000,
        timestamp: '2026-11-01T00:00:00.000Z',
        source: 'Billing',
      },
    ],
    syncedAt: new Date().toISOString(),
  };
}

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

  // Write sanitized demo snapshot (never reads personal ~/.gemini/antigravity into public dist/)
  const snapshotJson = JSON.stringify(createAnonymizedFallback(), null, 2);
  const distFallbackPath = path.join(DIST_DIR, 'api-fallback.json');
  fs.writeFileSync(distFallbackPath, snapshotJson, 'utf8');
  builtFiles.push({ file: 'api-fallback.json', size: fs.statSync(distFallbackPath).size });

  // Keep root fallback & .nojekyll in sync in case Pages serves from main
  fs.writeFileSync(path.join(ROOT_DIR, 'api-fallback.json'), snapshotJson, 'utf8');
  fs.writeFileSync(path.join(ROOT_DIR, '.nojekyll'), '', 'utf8');

  // Prevent GitHub Pages Jekyll processing
  const nojekyllPath = path.join(DIST_DIR, '.nojekyll');
  fs.writeFileSync(nojekyllPath, '', 'utf8');
  builtFiles.push({ file: '.nojekyll', size: 0 });

  console.log('Build completed -> dist/');
  for (const entry of builtFiles) {
    console.log(`  - ${entry.file} (${(entry.size / 1024).toFixed(1)} KB)`);
  }
}

build();
