const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
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

/**
 * Encrypt a JSON payload using PBKDF2-SHA256 + AES-256-GCM compatible with Web Crypto subtle.decrypt.
 */
function encryptPayloadForKey(payloadObj, passphrase) {
  const normalized = String(passphrase || '').trim().toLowerCase();
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(normalized, salt, 100000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payloadObj), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([encrypted, tag]);

  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    data: combined.toString('base64'),
  };
}

function getGitConfigValue(key) {
  try {
    return execSync(`git config --get ${key}`, { cwd: ROOT_DIR, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8')
      .trim();
  } catch {
    return '';
  }
}

function buildEncryptedCloudVault() {
  const telemetry = collectLocalAntigravityTelemetry();
  const rootVaultPath = path.join(ROOT_DIR, 'cloud-vault.json');

  // On CI runners without local Antigravity IDE data, preserve existing encrypted cloud-vault.json
  const hasRealLocalIde = telemetry && telemetry.email && telemetry.email !== 'local@antigravity.dev';
  if (!hasRealLocalIde) {
    if (fs.existsSync(rootVaultPath)) {
      return fs.readFileSync(rootVaultPath, 'utf8');
    }
    return JSON.stringify({ version: 1, vaults: [], updatedAt: new Date().toISOString() }, null, 2);
  }

  const keys = new Set();
  const addKeyAndPrefix = (val) => {
    const clean = String(val || '').trim().toLowerCase();
    if (!clean || clean === 'local@antigravity.dev') return;
    keys.add(clean);
    if (clean.includes('@')) {
      keys.add(clean.split('@')[0]);
    }
  };

  addKeyAndPrefix(telemetry.email);
  addKeyAndPrefix(getGitConfigValue('user.email'));
  addKeyAndPrefix(getGitConfigValue('user.name'));
  if (process.env.AG_VAULT_KEYS) {
    for (const k of process.env.AG_VAULT_KEYS.split(',')) {
      addKeyAndPrefix(k);
    }
  }

  const payload = {
    source: 'cloud-vault',
    name: telemetry.name,
    email: telemetry.email,
    plan: telemetry.plan,
    max: telemetry.max,
    used: telemetry.used,
    remaining: telemetry.remaining,
    resetDays: telemetry.resetDays,
    tasks: telemetry.tasks,
    models: telemetry.models || [],
    trend: telemetry.trend,
    trendLabels: telemetry.trendLabels,
    history: telemetry.history,
    syncedAt: telemetry.syncedAt,
  };

  const vaults = [...keys].map(k => encryptPayloadForKey(payload, k));
  const vaultFile = JSON.stringify({
    version: 1,
    algorithm: 'PBKDF2-SHA256-AES-256-GCM',
    iterations: 100000,
    vaults,
    updatedAt: new Date().toISOString(),
  }, null, 2);

  fs.writeFileSync(rootVaultPath, vaultFile, 'utf8');
  return vaultFile;
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

  // Write sanitized demo snapshot (never reads personal ~/.gemini/antigravity into plaintext dist/)
  const snapshotJson = JSON.stringify(createAnonymizedFallback(), null, 2);
  const distFallbackPath = path.join(DIST_DIR, 'api-fallback.json');
  fs.writeFileSync(distFallbackPath, snapshotJson, 'utf8');
  builtFiles.push({ file: 'api-fallback.json', size: fs.statSync(distFallbackPath).size });

  // Write AES-256-GCM encrypted cloud vault for mobile / remote login when PC is off
  const vaultContent = buildEncryptedCloudVault();
  const distVaultPath = path.join(DIST_DIR, 'cloud-vault.json');
  fs.writeFileSync(distVaultPath, vaultContent, 'utf8');
  builtFiles.push({ file: 'cloud-vault.json', size: fs.statSync(distVaultPath).size });

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
