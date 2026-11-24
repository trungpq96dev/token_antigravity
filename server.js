const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Load simple key=value pairs from .env if present (zero dependencies).
 */
function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnvFile();

const USE_DIST = process.argv.includes('--dist');
const STATIC_ROOT = USE_DIST ? path.join(__dirname, 'dist') : __dirname;
const PORT = Number(process.env.PORT || 3000);
const AG_DATA_DIR = process.env.AG_DATA_DIR || path.join(os.homedir(), '.gemini', 'antigravity');
const DEFAULT_MAX_TOKENS = Number(process.env.AG_DEFAULT_MAX_TOKENS || 2000000);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

/**
 * Return Vietnamese weekday labels for the last 7 days ending with "Today".
 */
function getLast7DayKeysAndLabels() {
  const vnDays = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
  const keys = [];
  const labels = [];
  const now = new Date();
  for (let offset = 6; offset >= 0; offset--) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - offset);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    keys.push(key);
    labels.push(offset === 0 ? 'Today' : vnDays[d.getDay()]);
  }
  return { keys, labels };
}

/**
 * Recursively find transcript or artifact files inside a conversation directory.
 */
function inspectConversationDir(convDir) {
  let totalBytes = 0;
  let latestMtimeMs = 0;
  let transcriptBytes = 0;

  function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs > latestMtimeMs) latestMtimeMs = stat.mtimeMs;
          if (entry.name === 'transcript_full.jsonl') {
            transcriptBytes = Math.max(transcriptBytes, stat.size);
          } else if (entry.name === 'transcript.jsonl' && transcriptBytes === 0) {
            transcriptBytes = stat.size;
          } else {
            totalBytes += stat.size;
          }
        } catch {
          // Ignore unreadable files
        }
      }
    }
  }

  walk(convDir, 0);
  const effectiveBytes = transcriptBytes > 0 ? transcriptBytes : totalBytes;
  return { bytes: effectiveBytes, mtimeMs: latestMtimeMs };
}

/**
 * Read active logged-in Antigravity IDE profile & model quota from local globalStorage (read-only).
 * Never reads or returns secret tokens/keys.
 */
function readAntigravityIdeAuthStatus() {
  const appDataDir = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const candidateVscdbs = [
    path.join(appDataDir, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'),
    path.join(appDataDir, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
  ];
  const appStoragePath = path.join(appDataDir, 'Antigravity', 'app_storage.json');

  let name = '';
  let email = '';
  let plan = 'Pro Plan';
  const models = [];

  for (const vscdbPath of candidateVscdbs) {
    if (!fs.existsSync(vscdbPath)) continue;
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(vscdbPath, { readOnly: true });

      const googleAgRow = db.prepare("SELECT value FROM ItemTable WHERE key = 'google.google-antigravity'").get();
      if (!email && googleAgRow && googleAgRow.value) {
        try {
          const parsed = JSON.parse(googleAgRow.value);
          const storedEmail = parsed?.['antigravity-storage']?.['agy.onboarding.lastLoginUsername'];
          if (typeof storedEmail === 'string' && storedEmail) email = storedEmail;
        } catch {
          // Ignore malformed JSON
        }
      }

      const authRow = db.prepare("SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'").get();
      const statusRow = db.prepare("SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.userStatus'").get();
      db.close();

      let protoBuf = null;
      if (authRow && authRow.value) {
        const auth = JSON.parse(authRow.value);
        if (!name && typeof auth.name === 'string') name = auth.name;
        if (!email && typeof auth.email === 'string') email = auth.email;
        if (typeof auth.userStatusProtoBinaryBase64 === 'string') {
          protoBuf = Buffer.from(auth.userStatusProtoBinaryBase64, 'base64');
        }
      } else if (statusRow && statusRow.value) {
        const outerStr = Buffer.from(statusRow.value, 'base64').toString('utf8');
        const b64Matches = outerStr.match(/[A-Za-z0-9+/=]{80,}/g) || [];
        if (b64Matches[0]) protoBuf = Buffer.from(b64Matches[0], 'base64');
      }

      if (protoBuf && models.length === 0) {
        const latin = protoBuf.toString('latin1');
        if (/g1-ultra-tier/i.test(latin)) plan = 'Ultra Plan';
        else if (/g1-pro-tier/i.test(latin)) plan = 'Google AI Pro';
        else if (/free/i.test(latin)) plan = 'Free Tier';

        const modelRegex = /(Gemini [0-9.]+ [A-Za-z]+ \([A-Za-z]+\)|Claude [A-Za-z]+ [0-9.]+ \([A-Za-z]+\)|GPT-OSS [0-9]+B \([A-Za-z]+\))/g;
        let m;
        while ((m = modelRegex.exec(latin)) !== null) {
          const slice = protoBuf.subarray(m.index + m[1].length, m.index + m[1].length + 35);
          const zIdx = slice.indexOf(0x7a);
          if (zIdx !== -1 && slice[zIdx + 2] === 0x0d) {
            const frac = slice.readFloatLE(zIdx + 3);
            if (Number.isFinite(frac) && frac >= 0 && frac <= 1) {
              models.push({ name: m[1], remainingPct: Math.round(frac * 1000) / 10 });
            }
          }
        }
      }
      if (email && models.length > 0) break;
    } catch {
      // Try next candidate
    }
  }

  if (!email && fs.existsSync(appStoragePath)) {
    try {
      const storage = JSON.parse(fs.readFileSync(appStoragePath, 'utf8'));
      if (typeof storage['agy.onboarding.lastLoginUsername'] === 'string') {
        email = storage['agy.onboarding.lastLoginUsername'];
      }
    } catch {
      // Ignore unreadable app_storage.json
    }
  }

  return { name, email, plan, models };
}

const BASELINE_PATH = path.join(__dirname, 'quota-baseline.json');

function loadOrInitQuotaBaseline(currentTotalBytes) {
  if (fs.existsSync(BASELINE_PATH)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
      if (parsed && parsed.gemini && parsed.claudeGpt) return parsed;
    } catch {
      // Reinitialize if malformed
    }
  }
  const nowMs = Date.now();
  const initial = {
    gemini: {
      weekly: { pct: 90, resetAt: new Date(nowMs + (6 * 24 + 20) * 3600 * 1000).toISOString() },
      fiveHour: { pct: 65, resetAt: new Date(nowMs + 60 * 60 * 1000).toISOString() },
    },
    claudeGpt: {
      weekly: { pct: 49, resetAt: new Date(nowMs + (6 * 24 + 10) * 3600 * 1000).toISOString() },
      fiveHour: { pct: 100, resetAt: null },
    },
    baselineTotalBytes: currentTotalBytes,
    updatedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(initial, null, 2), 'utf8');
  } catch {
    // Ignore read-only filesystem
  }
  return initial;
}

function saveQuotaBaseline(baseline) {
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2), 'utf8');
}

/**
 * Scan local ~/.gemini/antigravity data and IDE auth state to compute live telemetry.
 */
function collectLocalAntigravityTelemetry(maxTokens = DEFAULT_MAX_TOKENS) {
  const ideProfile = readAntigravityIdeAuthStatus();
  const brainDir = path.join(AG_DATA_DIR, 'brain');
  const { keys: dayKeys, labels: trendLabels } = getLast7DayKeysAndLabels();
  const dailyTokenMap = Object.fromEntries(dayKeys.map(k => [k, 0]));
  const sessions = [];

  let totalTranscriptBytes = 0;

  if (fs.existsSync(brainDir)) {
    let convDirs = [];
    try {
      convDirs = fs.readdirSync(brainDir, { withFileTypes: true }).filter(d => d.isDirectory());
    } catch {
      convDirs = [];
    }

    for (const dir of convDirs) {
      const convPath = path.join(brainDir, dir.name);
      const { bytes, mtimeMs } = inspectConversationDir(convPath);
      if (bytes <= 0 || mtimeMs <= 0) continue;
      totalTranscriptBytes += bytes;

      // Approximate 1 token per 4 bytes of serialized transcript/artifact data
      const estTokens = Math.max(250, Math.round(bytes / 4));
      const d = new Date(mtimeMs);
      const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (dayKey in dailyTokenMap) {
        dailyTokenMap[dayKey] += estTokens;
      }

      sessions.push({
        id: dir.name,
        shortId: dir.name.slice(0, 8),
        tokens: estTokens,
        mtimeMs,
        timestamp: d.toISOString(),
      });
    }
  }

  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // Sum usage from the last 7 days for realistic current-cycle remaining quota
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentTokens = sessions
    .filter(s => s.mtimeMs >= sevenDaysAgo)
    .reduce((sum, s) => sum + s.tokens, 0);

  const avgModelRemainingPct = ideProfile.models.length > 0
    ? ideProfile.models.reduce((s, m) => s + m.remainingPct, 0) / ideProfile.models.length
    : null;

  let remaining;
  let used;
  if (avgModelRemainingPct !== null) {
    remaining = Math.round(maxTokens * (avgModelRemainingPct / 100));
    used = recentTokens > 0 ? recentTokens : Math.max(0, maxTokens - remaining);
  } else {
    used = recentTokens > 0 ? Math.min(maxTokens, recentTokens) : 0;
    remaining = Math.max(0, maxTokens - used);
  }

  const agentUsed = Math.round(used * 0.655);
  const autoUsed = Math.round(used * 0.25);
  const chatUsed = Math.max(0, used - agentUsed - autoUsed);

  const rawDaily = dayKeys.map(k => dailyTokenMap[k]);
  const maxDaily = Math.max(...rawDaily, 1);
  const hasAnyDaily = rawDaily.some(v => v > 0);
  const trend = hasAnyDaily
    ? rawDaily.map(v => (v === 0 ? 12 : Math.max(16, Math.min(96, Math.round((v / maxDaily) * 92)))))
    : [0, 0, 0, 0, 0, 0, 0];

  const now = new Date();
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const resetDays = Math.max(1, Math.ceil((endOfMonth - now) / (24 * 60 * 60 * 1000)));

  const taskCycle = ['Agent & Reasoning', 'Code Autocomplete', 'Quick Chat'];
  const history = sessions.slice(0, 12).map((s, idx) => ({
    id: `tx-${s.shortId}`,
    title: `Session #${s.shortId}`,
    taskType: taskCycle[idx % taskCycle.length],
    delta: -s.tokens,
    timestamp: s.timestamp,
    source: 'Local Telemetry',
  }));

  const nowMs = Date.now();
  const baseline = loadOrInitQuotaBaseline(totalTranscriptBytes);
  const deltaBytes = Math.max(0, totalTranscriptBytes - Number(baseline.baselineTotalBytes || totalTranscriptBytes));

  const resolveQuotaItem = (item, deltaPct) => {
    if (item.resetAt && new Date(item.resetAt).getTime() <= nowMs) {
      return { pct: 100, resetAt: null };
    }
    const basePct = Number(item.pct) || 0;
    return {
      pct: Math.max(0, Math.min(100, Math.round(basePct - deltaPct))),
      resetAt: item.resetAt || null,
    };
  };

  const quotaLimits = {
    gemini: {
      weekly: resolveQuotaItem(baseline.gemini.weekly, Math.floor(deltaBytes / 125000)),
      fiveHour: resolveQuotaItem(baseline.gemini.fiveHour, Math.floor(deltaBytes / 14000)),
    },
    claudeGpt: {
      weekly: resolveQuotaItem(baseline.claudeGpt.weekly, 0),
      fiveHour: resolveQuotaItem(baseline.claudeGpt.fiveHour, 0),
    },
  };

  const resolvedEmail = process.env.AG_USER_EMAIL || ideProfile.email || 'local@antigravity.dev';
  const resolvedName = process.env.AG_USER_NAME
    || (process.env.AG_USER_EMAIL ? process.env.AG_USER_EMAIL.split('@')[0] : '')
    || ideProfile.name
    || 'Local Antigravity IDE';

  return {
    source: 'local-antigravity',
    name: resolvedName,
    email: resolvedEmail,
    plan: ideProfile.plan || 'Pro Plan',
    max: maxTokens,
    used,
    remaining,
    resetDays,
    quotaLimits,
    tasks: {
      agent: agentUsed,
      auto: autoUsed,
      chat: chatUsed,
    },
    models: ideProfile.models,
    trend,
    trendLabels,
    dailyRawTokens: rawDaily,
    totalTranscriptBytes,
    sessionsScanned: sessions.length,
    history,
    syncedAt: new Date().toISOString(),
  };
}

/**
 * Send JSON HTTP response with CORS headers so github.io can talk to local bridge if running.
 */
function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(body);
}

/**
 * Read request body up to 1MB as parsed JSON.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Proxy external provider usage requests cleanly without persisting API keys on disk.
 */
async function handleFetchUsage(body) {
  const { provider, apiKey, apiEndpoint, maxTokens } = body;
  const max = Number(maxTokens) > 0 ? Number(maxTokens) : DEFAULT_MAX_TOKENS;

  if (provider === 'local') {
    return collectLocalAntigravityTelemetry(max);
  }

  if (provider === 'openrouter') {
    if (!apiKey) throw new Error('API key is required for OpenRouter.');
    const response = await fetch('https://openrouter.ai/api/v1/auth/key', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      throw new Error(`OpenRouter API returned HTTP ${response.status}`);
    }
    const json = await response.json();
    const data = json.data || {};
    // Convert credit/dollar usage into comparable token units (1 USD ~ 200,000 tokens if limit is set)
    const limitUsd = typeof data.limit === 'number' && data.limit > 0 ? data.limit : 10;
    const usageUsd = typeof data.usage === 'number' ? data.usage : 0;
    const ratioRemaining = Math.max(0, Math.min(1, (limitUsd - usageUsd) / limitUsd));
    const remaining = Math.round(max * ratioRemaining);
    const used = Math.max(0, max - remaining);
    return {
      source: 'openrouter',
      max,
      used,
      remaining,
      tasks: {
        agent: Math.round(used * 0.65),
        auto: Math.round(used * 0.25),
        chat: Math.max(0, used - Math.round(used * 0.65) - Math.round(used * 0.25)),
      },
      syncedAt: new Date().toISOString(),
      meta: { label: data.label || 'OpenRouter Key', usageUsd, limitUsd },
    };
  }

  if (provider === 'gemini') {
    if (!apiKey) throw new Error('API key is required for Gemini.');
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
    );
    if (!response.ok) {
      throw new Error(`Gemini API validation failed (HTTP ${response.status})`);
    }
    const local = collectLocalAntigravityTelemetry(max);
    return {
      ...local,
      source: 'gemini-verified',
    };
  }

  if (provider === 'custom') {
    const endpoint = apiEndpoint || process.env.CUSTOM_USAGE_API_URL;
    if (!endpoint) throw new Error('Custom API endpoint URL is required.');
    const headers = { Accept: 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const response = await fetch(endpoint, { headers });
    if (!response.ok) {
      throw new Error(`Custom endpoint returned HTTP ${response.status}`);
    }
    const data = await response.json();
    const resolvedMax = Number(data.max || data.limit || max);
    const resolvedRemaining =
      typeof data.remaining === 'number'
        ? data.remaining
        : Math.max(0, resolvedMax - Number(data.used || 0));
    const used = Math.max(0, resolvedMax - resolvedRemaining);

    return {
      source: 'custom',
      max: resolvedMax,
      used,
      remaining: resolvedRemaining,
      resetDays: Number(data.resetDays || 14),
      tasks: data.tasks || {
        agent: Math.round(used * 0.65),
        auto: Math.round(used * 0.25),
        chat: Math.max(0, used - Math.round(used * 0.65) - Math.round(used * 0.25)),
      },
      trend: Array.isArray(data.trend) && data.trend.length === 7 ? data.trend : undefined,
      syncedAt: new Date().toISOString(),
    };
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  if (req.method === 'GET' && pathname === '/api/local-antigravity') {
    const maxParam = Number(urlObj.searchParams.get('max') || DEFAULT_MAX_TOKENS);
    const telemetry = collectLocalAntigravityTelemetry(maxParam > 0 ? maxParam : DEFAULT_MAX_TOKENS);
    return sendJson(res, 200, telemetry);
  }

  if (req.method === 'POST' && pathname === '/api/update-quota') {
    try {
      const body = await readJsonBody(req);
      const current = collectLocalAntigravityTelemetry();
      const prev = loadOrInitQuotaBaseline(current.totalTranscriptBytes || 0);
      const clamp = v => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
      const updated = {
        gemini: {
          weekly: { pct: clamp(body.geminiWeekly ?? prev.gemini.weekly.pct), resetAt: body.geminiWeeklyResetAt ?? prev.gemini.weekly.resetAt },
          fiveHour: { pct: clamp(body.gemini5h ?? prev.gemini.fiveHour.pct), resetAt: body.gemini5hResetAt ?? prev.gemini.fiveHour.resetAt },
        },
        claudeGpt: {
          weekly: { pct: clamp(body.claudeWeekly ?? prev.claudeGpt.weekly.pct), resetAt: body.claudeWeeklyResetAt ?? prev.claudeGpt.weekly.resetAt },
          fiveHour: { pct: clamp(body.claude5h ?? prev.claudeGpt.fiveHour.pct), resetAt: body.claude5hResetAt ?? prev.claudeGpt.fiveHour.resetAt },
        },
        baselineTotalBytes: current.totalTranscriptBytes || 0,
        updatedAt: new Date().toISOString(),
      };
      saveQuotaBaseline(updated);
      return sendJson(res, 200, { ok: true, quotaLimits: updated });
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'Failed to update quota baseline' });
    }
  }

  if (req.method === 'POST' && pathname === '/api/fetch-usage') {
    try {
      const body = await readJsonBody(req);
      const result = await handleFetchUsage(body);
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'Failed to fetch usage' });
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end('Method Not Allowed');
  }

  const reqPath = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const safePath = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(STATIC_ROOT, safePath);

  if (!filePath.startsWith(STATIC_ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
});

function startServer(port, attemptsRemaining = 20) {
  const onError = (err) => {
    if (err.code === 'EADDRINUSE' && attemptsRemaining > 0) {
      const nextPort = port + 1;
      console.warn(`Port ${port} is already in use, trying port ${nextPort}...`);
      startServer(nextPort, attemptsRemaining - 1);
      return;
    }
    throw err;
  };

  server.once('error', onError);
  server.listen(port, () => {
    server.removeListener('error', onError);
    console.log(`Antigravity Token Dashboard running at http://localhost:${port} (serving ${STATIC_ROOT})`);
  });
}

if (require.main === module) {
  startServer(PORT);
}

module.exports = { server, startServer, collectLocalAntigravityTelemetry };
