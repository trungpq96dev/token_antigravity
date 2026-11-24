#!/usr/bin/env node
/**
 * Antigravity Quota Collector Daemon for Ubuntu Server
 * - Polls Antigravity CLI (`agy`) `/usage` inside detached tmux sessions every 60 seconds (costs 0 AI tokens).
 * - Reads both `~/.gemini/antigravity-cli/latest-status.json` (statusLine hook) and `/usage` TUI screen text.
 * - Pushes encrypted AES-256-GCM `cloud-vault.json` to orphan branch `quota-data` ONLY when % changes
 *   (using a single amended commit so `.git` never bloats and GitHub Pages build limits are never triggered).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, execSync } = require('child_process');

const BASE_DIR = process.env.AG_TRACKER_DIR || '/opt/ag-tracker';
const PROFILES_DIR = path.join(BASE_DIR, 'profiles');
const STATE_DIR = path.join(BASE_DIR, 'state');
const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
const POLL_INTERVAL_MS = Number(process.env.AG_POLL_INTERVAL_MS || 60 * 1000);
const MIN_PUSH_COOLDOWN_MS = Number(process.env.AG_MIN_PUSH_COOLDOWN_MS || 90 * 1000);
const HEARTBEAT_PUSH_MS = Number(process.env.AG_HEARTBEAT_PUSH_MS || 30 * 60 * 1000);

fs.mkdirSync(PROFILES_DIR, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {
      repoUrl: 'https://github.com/trungpq96dev/token_antigravity.git',
      gitToken: '',
      branch: 'quota-data',
      extraAliases: {},
    };
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {
      repoUrl: 'https://github.com/trungpq96dev/token_antigravity.git',
      gitToken: '',
      branch: 'quota-data',
      extraAliases: {},
    };
  }
}

function findAgyBinary() {
  const candidates = [
    process.env.AGY_BIN,
    '/usr/local/bin/agy',
    '/root/.local/bin/agy',
    path.join(process.env.HOME || '/root', '.local/bin/agy'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    return execSync('command -v agy', { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
  } catch {
    return 'agy';
  }
}

function ensureProfileSettings(profileHome) {
  const cliDir = path.join(profileHome, '.gemini', 'antigravity-cli');
  fs.mkdirSync(cliDir, { recursive: true });
  const settingsPath = path.join(cliDir, 'settings.json');
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      settings = {};
    }
  }
  settings.altScreenMode = 'always';
  settings.statusLine = {
    type: 'command',
    command: '/opt/ag-tracker/repo/ubuntu/statusline-hook.sh',
    enabled: true,
    stack_with_default: true,
  };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
}

function tmuxHasSession(sessionName) {
  try {
    execFileSync('tmux', ['has-session', '-t', sessionName], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function ensureTmuxSession(alias, profileHome, agyBin) {
  const sessionName = `agy_${alias.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  ensureProfileSettings(profileHome);
  if (!tmuxHasSession(sessionName)) {
    execFileSync('tmux', [
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-x',
      '120',
      '-y',
      '40',
      `HOME="${profileHome}" "${agyBin}"`,
    ]);
    return { sessionName, justStarted: true };
  }
  return { sessionName, justStarted: false };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseDurationTextToIso(text) {
  if (!text) return null;
  const daysMatch = text.match(/(\d+)\s*day/i);
  const hoursMatch = text.match(/(\d+)\s*hour/i);
  const minsMatch = text.match(/(\d+)\s*min/i);
  const days = daysMatch ? Number(daysMatch[1]) : 0;
  const hours = hoursMatch ? Number(hoursMatch[1]) : 0;
  const mins = minsMatch ? Number(minsMatch[1]) : 0;
  const totalMs = ((days * 24 + hours) * 60 + mins) * 60 * 1000;
  if (totalMs <= 0) return null;
  return new Date(Date.now() + totalMs).toISOString();
}

/**
 * Parse TUI `/usage` output captured via `tmux capture-pane`.
 */
function parseUsagePaneText(paneText) {
  const clean = String(paneText || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  const result = {
    geminiWeekly: null,
    gemini5h: null,
    claudeWeekly: null,
    claude5h: null,
    models: [],
  };

  // Split into sections around Gemini and Claude/GPT headers if present
  const geminiIdx = clean.search(/Gemini\s+Models/i);
  const claudeIdx = clean.search(/Claude\s+(?:and|&)\s+GPT/i);

  const extractLimitsFromBlock = (block) => {
    let weekly = null;
    let fiveHour = null;
    const wMatch = block.match(/Weekly[^\n%]{0,80}?(\d{1,3})\s*%([\s\S]{0,160})/i);
    if (wMatch) {
      weekly = {
        pct: Math.min(100, Number(wMatch[1])),
        resetAt: parseDurationTextToIso(wMatch[2]),
      };
    }
    const hMatch = block.match(/(?:Five[\s-]Hour|5[\s-]hour)[^\n%]{0,80}?(\d{1,3})\s*%([\s\S]{0,160})/i);
    if (hMatch) {
      fiveHour = {
        pct: Math.min(100, Number(hMatch[1])),
        resetAt: parseDurationTextToIso(hMatch[2]),
      };
    }
    return { weekly, fiveHour };
  };

  if (geminiIdx !== -1) {
    const end = claudeIdx > geminiIdx ? claudeIdx : clean.length;
    const parsed = extractLimitsFromBlock(clean.slice(geminiIdx, end));
    result.geminiWeekly = parsed.weekly;
    result.gemini5h = parsed.fiveHour;
  }
  if (claudeIdx !== -1) {
    const parsed = extractLimitsFromBlock(clean.slice(claudeIdx));
    result.claudeWeekly = parsed.weekly;
    result.claude5h = parsed.fiveHour;
  }

  // Also capture per-model lines like "Gemini 4 Carbon (High) ... 90%"
  const lineRegex = /((?:Gemini|Claude|GPT)[^\n%]{2,40}?)\s+(\d{1,3}(?:\.\d+)?)\s*%/gi;
  let m;
  while ((m = lineRegex.exec(clean)) !== null) {
    const mName = m[1].trim();
    if (/Weekly|Hour|Limit|Models/i.test(mName)) continue;
    result.models.push({ name: mName, remainingPct: Math.min(100, Number(m[2])) });
  }

  return result;
}

/**
 * Parse `~/.gemini/antigravity-cli/latest-status.json` piped by `agy` statusLine.
 */
function parseStatusLineJson(statusObj) {
  if (!statusObj || typeof statusObj !== 'object') return null;
  const quota = statusObj.quota || {};
  const out = {
    email: statusObj.email || '',
    plan: statusObj.plan_tier ? `Google AI ${statusObj.plan_tier}` : '',
    geminiWeekly: null,
    gemini5h: null,
    claudeWeekly: null,
    claude5h: null,
  };

  const toItem = (bucket) => {
    if (!bucket || typeof bucket !== 'object') return null;
    let pct = null;
    if (typeof bucket.remaining_fraction === 'number') {
      pct = Math.round(bucket.remaining_fraction * 100);
    } else if (typeof bucket.remaining_percentage === 'number') {
      pct = Math.round(bucket.remaining_percentage);
    }
    if (pct === null) return null;
    let resetAt = bucket.reset_time || null;
    if (!resetAt && typeof bucket.reset_in_seconds === 'number' && bucket.reset_in_seconds > 0) {
      resetAt = new Date(Date.now() + bucket.reset_in_seconds * 1000).toISOString();
    }
    return { pct: Math.max(0, Math.min(100, pct)), resetAt };
  };

  for (const [bucketKey, val] of Object.entries(quota)) {
    const k = bucketKey.toLowerCase();
    const item = toItem(val);
    if (!item) continue;
    if (k.includes('gemini') && k.includes('week')) out.geminiWeekly = item;
    else if (k.includes('gemini') && (k.includes('5') || k.includes('five') || k.includes('hour'))) out.gemini5h = item;
    else if ((k.includes('claude') || k.includes('gpt') || k.includes('third')) && k.includes('week')) out.claudeWeekly = item;
    else if ((k.includes('claude') || k.includes('gpt') || k.includes('third')) && (k.includes('5') || k.includes('five') || k.includes('hour'))) out.claude5h = item;
  }

  return out;
}

async function pollProfile(alias, profileHome, agyBin) {
  const { sessionName, justStarted } = ensureTmuxSession(alias, profileHome, agyBin);
  if (justStarted) {
    await sleep(4000);
  }

  // Trigger `/usage` refresh inside tmux (costs 0 tokens, refreshes quota from Google backend)
  try {
    execFileSync('tmux', ['send-keys', '-t', sessionName, 'Escape']);
    await sleep(300);
    execFileSync('tmux', ['send-keys', '-t', sessionName, '/usage', 'Enter']);
    await sleep(3500);
  } catch {
    return null;
  }

  let paneText = '';
  try {
    paneText = execFileSync('tmux', ['capture-pane', '-p', '-t', sessionName, '-S', '-120'], {
      encoding: 'utf8',
    });
    execFileSync('tmux', ['send-keys', '-t', sessionName, 'Escape']);
  } catch {
    paneText = '';
  }

  const statusPath = path.join(profileHome, '.gemini', 'antigravity-cli', 'latest-status.json');
  let statusObj = null;
  if (fs.existsSync(statusPath)) {
    try {
      statusObj = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    } catch {
      statusObj = null;
    }
  }

  const fromStatus = parseStatusLineJson(statusObj) || {};
  const fromPane = parseUsagePaneText(paneText);

  const geminiWeekly = fromPane.geminiWeekly || fromStatus.geminiWeekly || { pct: 100, resetAt: null };
  const gemini5h = fromPane.gemini5h || fromStatus.gemini5h || { pct: 100, resetAt: null };
  const claudeWeekly = fromPane.claudeWeekly || fromStatus.claudeWeekly || { pct: 100, resetAt: null };
  const claude5h = fromPane.claude5h || fromStatus.claude5h || { pct: 100, resetAt: null };

  // Detect if profile hasn't completed OAuth login yet
  const unauthenticated = /sign in|authorization url|paste.*code/i.test(paneText) && !fromStatus.email;
  if (unauthenticated) {
    return { alias, unauthenticated: true };
  }

  const email = fromStatus.email || `${alias}@gmail.com`;
  const displayName = alias;
  const plan = fromStatus.plan || 'Google AI Pro';
  const avgPct = Math.round(((geminiWeekly.pct + gemini5h.pct + claudeWeekly.pct + claude5h.pct) / 4) * 10) / 10;

  return {
    alias,
    unauthenticated: false,
    payload: {
      source: 'cloud-vault',
      name: displayName,
      email,
      plan,
      max: 100,
      remaining: avgPct,
      used: Math.max(0, 100 - avgPct),
      resetDays: 7,
      quotaLimits: {
        gemini: { weekly: geminiWeekly, fiveHour: gemini5h },
        claudeGpt: { weekly: claudeWeekly, fiveHour: claude5h },
      },
      models: fromPane.models || [],
      history: [],
      syncedAt: new Date().toISOString(),
    },
  };
}

function encryptPayloadForKey(payloadObj, passphrase) {
  const normalized = String(passphrase || '').trim().toLowerCase();
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(normalized, salt, 100000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payloadObj), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    data: Buffer.concat([encrypted, tag]).toString('base64'),
  };
}

function pushVaultToOrphanBranch(vaultJsonStr, config) {
  if (!config.gitToken || !config.repoUrl) {
    console.warn('[ag-tracker] GitHub token not configured yet. Run: sudo ag-tracker set-token <GITHUB_PAT>');
    return false;
  }

  const workDir = path.join(STATE_DIR, 'git-push-worktree');
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  const authedUrl = config.repoUrl.replace(
    /^https:\/\//i,
    `https://x-access-token:${encodeURIComponent(config.gitToken)}@`
  );
  const branch = config.branch || 'quota-data';

  try {
    execFileSync('git', ['init', '-q'], { cwd: workDir });
    execFileSync('git', ['config', 'user.name', 'ag-tracker-bot'], { cwd: workDir });
    execFileSync('git', ['config', 'user.email', 'bot@antigravity.local'], { cwd: workDir });
    fs.writeFileSync(path.join(workDir, 'cloud-vault.json'), vaultJsonStr, 'utf8');
    execFileSync('git', ['add', 'cloud-vault.json'], { cwd: workDir });
    execFileSync('git', ['commit', '-q', '-m', 'chore: update live encrypted quota vault'], { cwd: workDir });
    execFileSync('git', ['push', '-q', '-f', authedUrl, `HEAD:refs/heads/${branch}`], {
      cwd: workDir,
      stdio: 'ignore',
    });
    return true;
  } catch (err) {
    console.error('[ag-tracker] Git push failed:', err.message);
    return false;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

let lastPushedFingerprint = '';
let lastPushTimeMs = 0;

async function runCycle(options = {}) {
  const agyBin = findAgyBinary();
  const config = loadConfig();
  const entries = fs.existsSync(PROFILES_DIR)
    ? fs.readdirSync(PROFILES_DIR, { withFileTypes: true }).filter(d => d.isDirectory())
    : [];

  if (entries.length === 0) {
    if (options.printStatus) {
      console.log('Chưa có tài khoản nào được đăng nhập. Chạy: sudo ag-tracker login <ten_goi_nho>');
    }
    return;
  }

  const activeResults = [];
  for (const dir of entries) {
    const profileHome = path.join(PROFILES_DIR, dir.name);
    const res = await pollProfile(dir.name, profileHome, agyBin);
    if (!res) continue;
    if (res.unauthenticated) {
      if (options.printStatus) {
        console.log(`- [${dir.name}]: Chưa hoàn tất đăng nhập OAuth (chạy: sudo ag-tracker login ${dir.name})`);
      }
      continue;
    }
    activeResults.push(res);
    fs.writeFileSync(
      path.join(STATE_DIR, `${dir.name}.json`),
      JSON.stringify(res.payload, null, 2),
      'utf8'
    );
  }

  if (options.printStatus) {
    for (const r of activeResults) {
      const q = r.payload.quotaLimits;
      console.log(
        `✓ ${r.payload.name} (${r.payload.email}) [${r.payload.plan}] => ` +
          `Gemini: ${q.gemini.weekly.pct}% W / ${q.gemini.fiveHour.pct}% 5h | ` +
          `Claude/GPT: ${q.claudeGpt.weekly.pct}% W / ${q.claudeGpt.fiveHour.pct}% 5h`
      );
    }
  }

  if (activeResults.length === 0) return;

  // Fingerprint only rounded percentages so unchanged minutes make 0 GitHub commits
  const fingerprint = activeResults
    .map(r => {
      const q = r.payload.quotaLimits;
      return `${r.alias}:${q.gemini.weekly.pct}:${q.gemini.fiveHour.pct}:${q.claudeGpt.weekly.pct}:${q.claudeGpt.fiveHour.pct}`;
    })
    .join('|');

  const now = Date.now();
  const changed = fingerprint !== lastPushedFingerprint;
  const cooldownMet = now - lastPushTimeMs >= MIN_PUSH_COOLDOWN_MS;
  const heartbeatDue = now - lastPushTimeMs >= HEARTBEAT_PUSH_MS;

  if (!options.forcePush && !heartbeatDue && (!changed || !cooldownMet)) {
    return;
  }

  const vaults = [];
  for (const r of activeResults) {
    const keys = new Set();
    keys.add(r.alias.toLowerCase());
    if (r.payload.email) {
      const cleanEmail = r.payload.email.toLowerCase();
      keys.add(cleanEmail);
      if (cleanEmail.includes('@')) keys.add(cleanEmail.split('@')[0]);
    }
    const extras = (config.extraAliases && config.extraAliases[r.alias]) || [];
    for (const ex of extras) keys.add(String(ex).toLowerCase());

    for (const k of keys) {
      vaults.push(encryptPayloadForKey(r.payload, k));
    }
  }

  const vaultJsonStr = JSON.stringify(
    {
      version: 1,
      algorithm: 'PBKDF2-SHA256-AES-256-GCM',
      iterations: 100000,
      vaults,
      updatedAt: new Date().toISOString(),
    },
    null,
    2
  );

  const pushed = pushVaultToOrphanBranch(vaultJsonStr, config);
  if (pushed) {
    lastPushedFingerprint = fingerprint;
    lastPushTimeMs = now;
    console.log(`[ag-tracker] Synced ${activeResults.length} account(s) -> origin/${config.branch || 'quota-data'} (${fingerprint})`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--status')) {
    await runCycle({ printStatus: true, forcePush: false });
    return;
  }
  if (args.includes('--once')) {
    await runCycle({ printStatus: true, forcePush: true });
    return;
  }

  console.log(`[ag-tracker] Starting 1-minute smart-diff collector (interval=${POLL_INTERVAL_MS}ms)...`);
  while (true) {
    try {
      await runCycle();
    } catch (err) {
      console.error('[ag-tracker] Cycle error:', err.message);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

main();
