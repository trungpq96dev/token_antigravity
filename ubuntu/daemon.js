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
const http = require('http');
const crypto = require('crypto');
const { execFileSync, execSync } = require('child_process');

const BASE_DIR = process.env.AG_TRACKER_DIR || '/opt/ag-tracker';
const PROFILES_DIR = path.join(BASE_DIR, 'profiles');
const STATE_DIR = path.join(BASE_DIR, 'state');
const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
const TUNNEL_URL_PATH = path.join(STATE_DIR, 'tunnel-url.txt');
const HTTP_PORT = Number(process.env.AG_HTTP_PORT || 3888);
const POLL_INTERVAL_MS = Number(process.env.AG_POLL_INTERVAL_MS || 60 * 1000);
const MIN_PUSH_COOLDOWN_MS = Number(process.env.AG_MIN_PUSH_COOLDOWN_MS || 90 * 1000);
const HEARTBEAT_PUSH_MS = Number(process.env.AG_HEARTBEAT_PUSH_MS || 30 * 60 * 1000);

fs.mkdirSync(PROFILES_DIR, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });

function loadConfig() {
  const defaults = {
    repoUrl: 'https://github.com/trungpq96dev/token_antigravity.git',
    gitToken: '',
    branch: 'quota-data',
    extraAliases: {},
    apiSecret: '',
    customTunnelUrl: '',
  };
  let cfg = { ...defaults };
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      cfg = { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
    } catch {
      cfg = { ...defaults };
    }
  }
  if (!cfg.apiSecret) {
    cfg.apiSecret = crypto.randomBytes(24).toString('hex');
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    } catch {
      // Ignore if read-only in test mode
    }
  }
  return cfg;
}

function getCurrentTunnelUrl(config) {
  if (config && config.customTunnelUrl && /^https:\/\/[a-z0-9.-]+/i.test(config.customTunnelUrl.trim())) {
    return config.customTunnelUrl.trim().replace(/\/+$/, '');
  }
  if (fs.existsSync(TUNNEL_URL_PATH)) {
    try {
      const raw = fs.readFileSync(TUNNEL_URL_PATH, 'utf8').trim().replace(/\/+$/, '');
      if (/^https:\/\/[a-z0-9.-]+$/i.test(raw)) return raw;
    } catch {
      // Ignore read errors
    }
  }
  return '';
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
    try {
      execFileSync('tmux', [
        'new-session',
        '-d',
        '-s',
        sessionName,
        '-x',
        '220',
        '-y',
        '50',
        `HOME="${profileHome}" "${agyBin}"`,
      ], { stdio: 'ignore' });
      return { sessionName, justStarted: true };
    } catch (err) {
      // Another process (e.g. systemd daemon) created the session at the same millisecond
      if (tmuxHasSession(sessionName)) {
        return { sessionName, justStarted: false };
      }
      throw err;
    }
  }
  return { sessionName, justStarted: false };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseDurationTextToIso(text) {
  if (!text) return null;
  const daysMatch = text.match(/(\d+)\s*(?:days?|d)\b/i);
  const hoursMatch = text.match(/(\d+)\s*(?:hours?|hrs?|h)\b/i);
  const minsMatch = text.match(/(\d+)\s*(?:minutes?|mins?|m)\b/i);
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
    email: '',
    geminiWeekly: null,
    gemini5h: null,
    claudeWeekly: null,
    claude5h: null,
    models: [],
  };

  const accMatch = clean.match(/Account:\s*([^\s\r\n]+@[^\s\r\n]+)/i);
  if (accMatch) result.email = accMatch[1].trim();

  // Split into sections around GEMINI MODELS and CLAUDE AND GPT MODELS
  const geminiIdx = clean.search(/GEMINI\s+MODELS/i);
  const claudeIdx = clean.search(/CLAUDE\s+(?:AND|&)\s+GPT\s+MODELS/i);

  const extractLimitsFromBlock = (block) => {
    const fiveIdx = block.search(/(?:Five[\s-]Hour|5[\s-]hour)\s+Limit\s+Remaining/i);
    const weeklyPart = fiveIdx !== -1 ? block.slice(0, fiveIdx) : block;
    const fivePart = fiveIdx !== -1 ? block.slice(fiveIdx) : '';

    const parseSubLimit = (part, headerRe) => {
      if (!part) return null;
      const m = part.match(headerRe);
      if (!m) return null;
      const after = part.slice(m.index + m[0].length);
      const refMatch = after.match(/refresh(?:es)?\s+in\s+([^\r\n]+)/i);
      return {
        pct: Math.min(100, Math.round(Number(m[1]) * 100) / 100),
        resetAt: refMatch ? parseDurationTextToIso(refMatch[1]) : null,
      };
    };

    const weekly = parseSubLimit(
      weeklyPart,
      /Weekly\s+Limit\s+Remaining[\s\S]{0,160}?(\d{1,3}(?:\.\d+)?)\s*%/i
    );
    let fiveHour = parseSubLimit(
      fivePart,
      /(?:Five[\s-]Hour|5[\s-]hour)\s+Limit\s+Remaining[\s\S]{0,160}?(\d{1,3}(?:\.\d+)?)\s*%/i
    );
    if (
      !fiveHour &&
      (/(?:Five[\s-]Hour|5[\s-]hour)\s+Limit\s+Remaining[\s\S]{0,160}?Disabled\b/i.test(fivePart) ||
        (weekly && weekly.pct <= 0))
    ) {
      fiveHour = {
        pct: 0,
        resetAt: weekly ? weekly.resetAt : null,
        disabled: true,
      };
    }
    const groupModels = [];
    const gmMatch = block.match(/Models\s+within\s+this\s+group:\s*([^\r\n]+)/i);
    if (gmMatch) {
      for (const rawName of gmMatch[1].split(',')) {
        const trimmed = rawName.trim().replace(/\.+$/, '');
        const unbalancedParen = trimmed.includes('(') && !trimmed.includes(')');
        if (trimmed.length >= 3 && !trimmed.endsWith('Orch') && !unbalancedParen) {
          groupModels.push(trimmed);
        }
      }
    }
    return { weekly, fiveHour, groupModels };
  };

  const effectiveGroupPct = (parsed) => {
    if (parsed.weekly && parsed.fiveHour) return Math.min(parsed.weekly.pct, parsed.fiveHour.pct);
    if (parsed.fiveHour) return parsed.fiveHour.pct;
    if (parsed.weekly) return parsed.weekly.pct;
    return 100;
  };

  if (geminiIdx !== -1) {
    const end = claudeIdx > geminiIdx ? claudeIdx : clean.length;
    const parsed = extractLimitsFromBlock(clean.slice(geminiIdx, end));
    result.geminiWeekly = parsed.weekly;
    result.gemini5h = parsed.fiveHour;
    const gPct = effectiveGroupPct(parsed);
    for (const mName of parsed.groupModels) {
      result.models.push({ name: mName, remainingPct: gPct });
    }
  }
  if (claudeIdx !== -1) {
    const parsed = extractLimitsFromBlock(clean.slice(claudeIdx));
    result.claudeWeekly = parsed.weekly;
    result.claude5h = parsed.fiveHour;
    const cPct = effectiveGroupPct(parsed);
    for (const mName of parsed.groupModels) {
      result.models.push({ name: mName, remainingPct: cPct });
    }
  }

  return result;
}

/**
 * Parse `~/.gemini/antigravity-cli/latest-status.json` piped by `agy` statusLine.
 */
function parseStatusLineJson(statusObj) {
  if (!statusObj || typeof statusObj !== 'object') return null;
  const quota = statusObj.quota || {};
  const rawPlan = String(statusObj.plan_tier || '').trim();
  const out = {
    email: statusObj.email || '',
    plan: rawPlan ? (/^google\s+ai/i.test(rawPlan) ? rawPlan : `Google AI ${rawPlan}`) : '',
    geminiWeekly: null,
    gemini5h: null,
    claudeWeekly: null,
    claude5h: null,
  };

  const toItem = (bucket) => {
    if (!bucket || typeof bucket !== 'object') return null;
    let pct = null;
    if (typeof bucket.remaining_fraction === 'number') {
      pct = Math.round(bucket.remaining_fraction * 10000) / 100;
    } else if (typeof bucket.remaining_percentage === 'number') {
      pct = Math.round(bucket.remaining_percentage * 100) / 100;
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

  let paneText = '';
  let fromPane = { email: '', geminiWeekly: null, gemini5h: null, claudeWeekly: null, claude5h: null, models: [] };

  // Trigger `/usage` refresh inside tmux (costs 0 tokens, refreshes quota from Google backend)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      execFileSync('tmux', ['send-keys', '-t', sessionName, 'Escape']);
      await sleep(300);
      execFileSync('tmux', ['send-keys', '-t', sessionName, '/usage', 'Enter']);
      await sleep(attempt === 0 ? 3500 : 4500);
      paneText = execFileSync('tmux', ['capture-pane', '-p', '-t', sessionName, '-S', '-120'], {
        encoding: 'utf8',
      });
      execFileSync('tmux', ['send-keys', '-t', sessionName, 'Escape']);
      fromPane = parseUsagePaneText(paneText);
      if (fromPane.geminiWeekly || fromPane.claudeWeekly || /sign in|authorization url|paste.*code/i.test(paneText)) {
        break;
      }
    } catch {
      return null;
    }
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

  const mergeLimitItem = (paneItem, statusItem, fallbackItem) => {
    if (paneItem && statusItem) {
      const preferStatusDecimal =
        Number.isInteger(paneItem.pct) &&
        !Number.isInteger(statusItem.pct) &&
        Math.round(statusItem.pct) === paneItem.pct;
      return {
        pct: preferStatusDecimal ? statusItem.pct : paneItem.pct,
        resetAt: paneItem.resetAt || statusItem.resetAt || null,
        ...(paneItem.disabled ? { disabled: true } : {}),
      };
    }
    return paneItem || statusItem || fallbackItem;
  };

  const geminiWeekly = mergeLimitItem(fromPane.geminiWeekly, fromStatus.geminiWeekly, { pct: 100, resetAt: null });
  const gemini5h = mergeLimitItem(
    fromPane.gemini5h,
    fromStatus.gemini5h,
    geminiWeekly.pct <= 0 ? { pct: 0, resetAt: geminiWeekly.resetAt, disabled: true } : { pct: 100, resetAt: null }
  );
  const claudeWeekly = mergeLimitItem(fromPane.claudeWeekly, fromStatus.claudeWeekly, { pct: 100, resetAt: null });
  const claude5h = mergeLimitItem(
    fromPane.claude5h,
    fromStatus.claude5h,
    claudeWeekly.pct <= 0 ? { pct: 0, resetAt: claudeWeekly.resetAt, disabled: true } : { pct: 100, resetAt: null }
  );

  // Detect if profile hasn't completed OAuth login yet
  const unauthenticated = /sign in|authorization url|paste.*code/i.test(paneText) && !fromPane.email && !fromStatus.email;
  if (unauthenticated) {
    return { alias, unauthenticated: true };
  }

  const email = fromPane.email || fromStatus.email || `${alias}@gmail.com`;
  const displayName = alias.startsWith('host_') && email.includes('@') ? email.split('@')[0] : alias;
  const plan = fromStatus.plan || 'Google AI Pro';
  const avgPct = Math.round(((geminiWeekly.pct + gemini5h.pct + claudeWeekly.pct + claude5h.pct) / 4) * 100) / 100;

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
      used: Math.max(0, Math.round((100 - avgPct) * 100) / 100),
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
const latestCache = new Map(); // alias -> { payload, fetchedAtMs }
const inflightPolls = new Map(); // alias -> Promise

async function pollProfileSerialized(alias, profileHome, agyBin) {
  if (inflightPolls.has(alias)) {
    return inflightPolls.get(alias);
  }
  const promise = (async () => {
    try {
      const res = await pollProfile(alias, profileHome, agyBin);
      if (res && !res.unauthenticated && res.payload) {
        latestCache.set(alias, { payload: res.payload, fetchedAtMs: Date.now() });
      }
      return res;
    } finally {
      inflightPolls.delete(alias);
    }
  })();
  inflightPolls.set(alias, promise);
  return promise;
}

const IMPORTED_HOMES_STATE_PATH = path.join(STATE_DIR, 'imported-homes.json');

function getDirLatestMtimeMs(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  let latest = 0;
  try {
    latest = fs.statSync(dirPath).mtimeMs || 0;
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const subPath = path.join(dirPath, entry.name);
      try {
        const st = fs.statSync(subPath);
        if (st.mtimeMs > latest) latest = st.mtimeMs;
      } catch {
        // Ignore transient temp files
      }
    }
  } catch {
    return 0;
  }
  return Math.floor(latest);
}

/**
 * Auto-discover `agy` logins performed directly in `/home/<user>` or `/root`
 * (outside `sudo ag-tracker login <alias>`) and mirror their auth dir into PROFILES_DIR.
 */
function importHostAgyProfiles() {
  if (process.platform === 'win32') return;
  let skipMap = {};
  if (fs.existsSync(IMPORTED_HOMES_STATE_PATH)) {
    try {
      skipMap = JSON.parse(fs.readFileSync(IMPORTED_HOMES_STATE_PATH, 'utf8')) || {};
    } catch {
      skipMap = {};
    }
  }

  const candidateHomes = [];
  if (fs.existsSync('/root/.gemini')) {
    candidateHomes.push({ user: 'root', homeDir: '/root' });
  }
  if (fs.existsSync('/home')) {
    try {
      for (const d of fs.readdirSync('/home', { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const uHome = path.join('/home', d.name);
        if (fs.existsSync(path.join(uHome, '.gemini'))) {
          candidateHomes.push({ user: d.name, homeDir: uHome });
        }
      }
    } catch {
      // Ignore unreadable /home
    }
  }

  for (const { user, homeDir } of candidateHomes) {
    const alias = `host_${user.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const destProfile = path.join(PROFILES_DIR, alias);
    if (fs.existsSync(destProfile)) continue;

    const geminiSrc = path.join(homeDir, '.gemini');
    const mtimeSignature = getDirLatestMtimeMs(geminiSrc);
    if (mtimeSignature <= 0) continue;
    if (skipMap[homeDir] && skipMap[homeDir] === mtimeSignature) continue;

    try {
      let hasAuthCandidate = false;
      for (const item of fs.readdirSync(geminiSrc)) {
        if (/antigravity|oauth|account|cred|google|cli/i.test(item)) {
          hasAuthCandidate = true;
          break;
        }
      }
      if (!hasAuthCandidate) continue;

      fs.mkdirSync(destProfile, { recursive: true });
      fs.cpSync(geminiSrc, path.join(destProfile, '.gemini'), { recursive: true, force: true });

      const configSrc = path.join(homeDir, '.config');
      if (fs.existsSync(configSrc)) {
        for (const item of fs.readdirSync(configSrc)) {
          if (/antigravity/i.test(item)) {
            fs.mkdirSync(path.join(destProfile, '.config'), { recursive: true });
            fs.cpSync(path.join(configSrc, item), path.join(destProfile, '.config', item), {
              recursive: true,
              force: true,
            });
          }
        }
      }
      console.log(`[ag-tracker] Auto-imported existing agy session from ${homeDir} -> ${alias}`);
    } catch (err) {
      console.warn(`[ag-tracker] Could not import ${homeDir}:`, err.message);
    }
  }
}

function markHostProfileSkipped(alias) {
  if (!alias.startsWith('host_')) return;
  const user = alias.slice('host_'.length);
  const homeDir = user === 'root' ? '/root' : path.join('/home', user);
  const mtimeSignature = getDirLatestMtimeMs(path.join(homeDir, '.gemini'));
  let skipMap = {};
  if (fs.existsSync(IMPORTED_HOMES_STATE_PATH)) {
    try {
      skipMap = JSON.parse(fs.readFileSync(IMPORTED_HOMES_STATE_PATH, 'utf8')) || {};
    } catch {
      skipMap = {};
    }
  }
  skipMap[homeDir] = mtimeSignature;
  try {
    fs.writeFileSync(IMPORTED_HOMES_STATE_PATH, JSON.stringify(skipMap, null, 2), 'utf8');
  } catch {
    // Ignore write errors
  }

  const sessionName = `agy_${alias.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  try {
    execFileSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' });
  } catch {
    // Session already gone
  }
  fs.rmSync(path.join(PROFILES_DIR, alias), { recursive: true, force: true });
  fs.rmSync(path.join(STATE_DIR, `${alias}.json`), { force: true });
}

async function runCycle(options = {}) {
  importHostAgyProfiles();
  const agyBin = findAgyBinary();
  const config = loadConfig();
  const tunnelUrl = getCurrentTunnelUrl(config);
  const entries = fs.existsSync(PROFILES_DIR)
    ? fs
        .readdirSync(PROFILES_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .sort((a, b) => {
          const aHost = a.name.startsWith('host_') ? 1 : 0;
          const bHost = b.name.startsWith('host_') ? 1 : 0;
          return aHost - bHost || a.name.localeCompare(b.name);
        })
    : [];

  if (entries.length === 0) {
    if (options.printStatus) {
      console.log('Chưa có tài khoản nào được đăng nhập. Chạy: sudo ag-tracker login <ten_goi_nho>');
    }
    return;
  }

  const activeResults = [];
  const seenEmails = new Set();
  for (const dir of entries) {
    const profileHome = path.join(PROFILES_DIR, dir.name);
    const res = await pollProfileSerialized(dir.name, profileHome, agyBin);
    if (!res) continue;
    if (res.unauthenticated) {
      if (dir.name.startsWith('host_')) {
        markHostProfileSkipped(dir.name);
        continue;
      }
      if (options.printStatus) {
        console.log(`- [${dir.name}]: Chưa hoàn tất đăng nhập OAuth (chạy: sudo ag-tracker login ${dir.name})`);
      }
      continue;
    }
    const normEmail = String(res.payload.email || '').trim().toLowerCase();
    if (normEmail && seenEmails.has(normEmail)) {
      if (dir.name.startsWith('host_')) {
        markHostProfileSkipped(dir.name);
      }
      continue;
    }
    if (normEmail) seenEmails.add(normEmail);

    if (tunnelUrl && config.apiSecret) {
      res.payload.liveEndpoint = {
        url: tunnelUrl,
        token: config.apiSecret,
        alias: res.alias,
      };
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
          `Gemini: ${q.gemini.weekly.pct}% Tuần / ${q.gemini.fiveHour.pct}% 5h | ` +
          `Claude/GPT: ${q.claudeGpt.weekly.pct}% Tuần / ${q.claudeGpt.fiveHour.pct}% 5h`
      );
    }
    if (tunnelUrl) {
      console.log(`⚡ Đường hầm thời gian thực (Tunnel): ${tunnelUrl}`);
    }
  }

  if (activeResults.length === 0) return;

  // Fingerprint percentages + tunnelUrl so unchanged minutes make 0 GitHub commits,
  // while tunnel URL rotation after reboot auto-syncs immediately
  const fingerprint =
    activeResults
      .map(r => {
        const q = r.payload.quotaLimits;
        return `${r.alias}:${q.gemini.weekly.pct}:${q.gemini.fiveHour.pct}:${q.claudeGpt.weekly.pct}:${q.claudeGpt.fiveHour.pct}`;
      })
      .join('|') + (tunnelUrl ? `@${tunnelUrl}` : '');

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
    if (r.alias.startsWith('host_')) {
      keys.add(r.alias.slice('host_'.length).toLowerCase());
    }
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

function constantTimeTokenMatch(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function resolveProfileAlias(requestedAlias, requestedEmail) {
  const entries = fs.existsSync(PROFILES_DIR)
    ? fs.readdirSync(PROFILES_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
    : [];
  if (entries.length === 0) return null;

  const cleanAlias = String(requestedAlias || '').trim().toLowerCase();
  const cleanEmail = String(requestedEmail || '').trim().toLowerCase();

  const readSavedEmail = (entryName) => {
    const cached = latestCache.get(entryName);
    if (cached && cached.payload && cached.payload.email) {
      return cached.payload.email.toLowerCase();
    }
    const stateFile = path.join(STATE_DIR, `${entryName}.json`);
    if (fs.existsSync(stateFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (parsed && parsed.email) return String(parsed.email).toLowerCase();
      } catch {
        // Ignore unreadable state file
      }
    }
    return '';
  };

  if (cleanEmail) {
    for (const entryName of entries) {
      if (readSavedEmail(entryName) === cleanEmail) return entryName;
    }
    const prefix = cleanEmail.includes('@') ? cleanEmail.split('@')[0] : cleanEmail;
    const byPrefix = entries.find(e => e.toLowerCase() === prefix);
    if (byPrefix) return byPrefix;
  }

  if (cleanAlias) {
    const direct = entries.find(e => e.toLowerCase() === cleanAlias);
    if (direct) return direct;
    for (const entryName of entries) {
      const savedEmail = readSavedEmail(entryName);
      if (savedEmail && savedEmail.split('@')[0] === cleanAlias) return entryName;
    }
  }

  if (cleanEmail || cleanAlias) {
    return null;
  }
  return entries[0];
}

function startRealtimeHttpServer() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const urlObj = new URL(req.url || '/', `http://127.0.0.1:${HTTP_PORT}`);
    if (urlObj.pathname === '/api/health') {
      const cfg = loadConfig();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, mode: 'ubuntu-realtime', tunnelActive: Boolean(getCurrentTunnelUrl(cfg)) }));
      return;
    }

    if (urlObj.pathname === '/api/live-usage' && (req.method === 'GET' || req.method === 'POST')) {
      const cfg = loadConfig();
      const authHeader = String(req.headers.authorization || '');
      const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      if (!constantTimeTokenMatch(bearer, cfg.apiSecret)) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      let body = {};
      if (req.method === 'POST') {
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const rawBody = Buffer.concat(chunks).toString('utf8');
          if (rawBody) body = JSON.parse(rawBody);
        } catch {
          body = {};
        }
      }

      const alias = resolveProfileAlias(
        body.alias || urlObj.searchParams.get('alias'),
        body.email || urlObj.searchParams.get('email')
      );
      if (!alias) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'No logged-in profile on Ubuntu' }));
        return;
      }

      const wantFresh = body.fresh !== false && urlObj.searchParams.get('fresh') !== '0';
      const cached = latestCache.get(alias);
      if (!wantFresh && cached && Date.now() - cached.fetchedAtMs < 75000) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ...cached.payload, source: 'ubuntu-realtime', cached: true }));
        return;
      }

      try {
        const agyBin = findAgyBinary();
        const profileHome = path.join(PROFILES_DIR, alias);
        const result = await pollProfileSerialized(alias, profileHome, agyBin);
        if (!result || result.unauthenticated || !result.payload) {
          res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Profile unavailable or unauthenticated' }));
          return;
        }
        const tunnelUrl = getCurrentTunnelUrl(cfg);
        const livePayload = {
          ...result.payload,
          source: 'ubuntu-realtime',
          cached: false,
          ...(tunnelUrl ? { liveEndpoint: { url: tunnelUrl, token: cfg.apiSecret, alias } } : {}),
        };
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(livePayload));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  server.listen(HTTP_PORT, '127.0.0.1', () => {
    console.log(`[ag-tracker] Realtime HTTP API listening on http://127.0.0.1:${HTTP_PORT}`);
  });
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

  startRealtimeHttpServer();
  console.log(`[ag-tracker] Starting 1-minute smart-diff collector + realtime server (interval=${POLL_INTERVAL_MS}ms)...`);
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
