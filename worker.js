/**
 * ============================================================
 *  Canva Education Invite System — Cloudflare Worker  v2
 *  Single-file · Module syntax · Enhanced Bulk Management
 * ============================================================
 *
 *  Required KV Namespace binding:  INVITE_KV
 *  Required Environment Variables:
 *    CANVA_INVITE_URL   – Actual Canva class invite link (never client-side)
 *    ADMIN_USERNAME     – Admin login username
 *    ADMIN_PASSWORD     – Admin login password
 *    SESSION_SECRET     – ≥32 char secret for signing sessions
 *
 *  KV Key Schema:
 *    code:{CODE}              → InviteCode object
 *    batch:{id}               → BatchResult object (TTL: 2h)
 *    session:{token}          → Session object (TTL: 24h)
 *    ratelimit:redeem:{ip}    → RateLimit counter
 *    ratelimit:login:{ip}     → RateLimit counter
 *    log:{padded_ts}:{rand}   → LogEntry (TTL: 90 days)
 */

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────
const CHARSET          = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0,O,1,I
const SESSION_TTL_S    = 86400;   // 24 h
const BATCH_TTL_S      = 7200;    // batch results kept 2 h
const RL_REDEEM_MAX    = 5;
const RL_REDEEM_WIN_S  = 900;
const RL_LOGIN_MAX     = 10;
const RL_LOGIN_WIN_S   = 900;
const LOG_PAGE         = 50;
const CODE_PAGE        = 40;
const BULK_MAX         = 2000;
const BULK_WARN_AT     = 200;     // show confirmation dialog at this threshold
const KV_WRITE_CHUNK   = 25;      // concurrent KV writes per batch

// ─────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    try {
      return await router(request, env);
    } catch (err) {
      console.error('Worker error:', err?.stack ?? err);
      return htmlResponse(page500(), 500);
    }
  }
};

// ─────────────────────────────────────────────────────────────
// ROUTER
// ─────────────────────────────────────────────────────────────
async function router(request, env) {
  const url    = new URL(request.url);
  const path   = url.pathname.replace(/\/$/, '') || '/';
  const method = request.method;

  // Public
  if (path === '/'       && method === 'GET')  return htmlResponse(publicPageHTML());
  if (path === '/redeem' && method === 'POST') return handleRedeem(request, env);

  // Admin shortcuts
  if (path === '/admin') return redirect('/admin/login');

  // Auth
  if (path === '/admin/login') {
    if (method === 'GET')  return htmlResponse(loginPageHTML());
    if (method === 'POST') return handleAdminLogin(request, env);
  }
  if (path === '/admin/logout' && method === 'POST') return handleAdminLogout(request, env);

  // Protected admin routes
  const A = (fn) => withAuth(request, env, fn);
  if (path === '/admin/dashboard'      && method === 'GET')  return A(adminDashboard);
  if (path === '/admin/codes'          && method === 'GET')  return A(adminCodesPage);
  if (path === '/admin/codes/create'   && method === 'POST') return A(handleCreateCode);
  if (path === '/admin/codes/bulk'     && method === 'POST') return A(handleBulkCreate);
  if (path === '/admin/codes/toggle'   && method === 'POST') return A(handleToggleCode);
  if (path === '/admin/codes/delete'   && method === 'POST') return A(handleDeleteCode);
  if (path === '/admin/codes/export'   && method === 'GET')  return A(handleExport);
  if (path === '/admin/logs'           && method === 'GET')  return A(adminLogsPage);

  return htmlResponse(page404(), 404);
}

// ─────────────────────────────────────────────────────────────
// AUTH MIDDLEWARE
// ─────────────────────────────────────────────────────────────
async function withAuth(request, env, handler) {
  const session = await getSession(request, env);
  if (!session) return redirect('/admin/login');
  return handler(request, env, session);
}

async function getSession(request, env) {
  const cookie = request.headers.get('Cookie') ?? '';
  const match  = cookie.match(/(?:^|;\s*)session=([^;]+)/);
  if (!match) return null;
  const token = await verifySignedToken(decodeURIComponent(match[1]), env.SESSION_SECRET);
  if (!token) return null;
  const raw = await env.INVITE_KV.get(`session:${token}`);
  if (!raw) return null;
  const sess = JSON.parse(raw);
  return Date.now() > sess.expires_at ? null : sess;
}

async function handleAdminLogin(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') ?? '0.0.0.0';
  const rl = await checkRateLimit(env, `ratelimit:login:${ip}`, RL_LOGIN_MAX, RL_LOGIN_WIN_S);
  if (!rl.allowed) return htmlResponse(loginPageHTML('Too many login attempts. Please wait 15 minutes.'), 429);

  const form     = await request.formData();
  const username = String(form.get('username') ?? '').trim();
  const password = String(form.get('password') ?? '');

  const ok = await timingSafeEqual(username, env.ADMIN_USERNAME ?? '') &&
             await timingSafeEqual(password, env.ADMIN_PASSWORD ?? '');
  if (!ok) {
    await logAction(env, { action: 'admin_login_fail', username, ip, timestamp: now() });
    return htmlResponse(loginPageHTML('Invalid username or password.'), 401);
  }

  const token     = hexRand(32);
  const signed    = await signToken(token, env.SESSION_SECRET);
  const csrfToken = hexRand(16);
  const session   = { token, csrf_token: csrfToken, expires_at: Date.now() + SESSION_TTL_S * 1000, username };
  await env.INVITE_KV.put(`session:${token}`, JSON.stringify(session), { expirationTtl: SESSION_TTL_S });
  await logAction(env, { action: 'admin_login_ok', username, ip, timestamp: now() });

  return new Response(null, {
    status: 302,
    headers: {
      Location: '/admin/dashboard',
      'Set-Cookie': `session=${encodeURIComponent(signed)}; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=${SESSION_TTL_S}`
    }
  });
}

async function handleAdminLogout(request, env) {
  const session = await getSession(request, env);
  if (session) await env.INVITE_KV.delete(`session:${session.token}`);
  return new Response(null, {
    status: 302,
    headers: { Location: '/admin/login', 'Set-Cookie': 'session=; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=0' }
  });
}

async function validateCSRF(request, session) {
  const form = await request.clone().formData().catch(() => null);
  if (!form) return false;
  return timingSafeEqual(String(form.get('_csrf') ?? ''), session.csrf_token);
}

// ─────────────────────────────────────────────────────────────
// RATE LIMITING
// ─────────────────────────────────────────────────────────────
async function checkRateLimit(env, key, max, windowSec) {
  const raw   = await env.INVITE_KV.get(key);
  let entry   = raw ? JSON.parse(raw) : { count: 0, reset_at: Date.now() + windowSec * 1000 };
  if (Date.now() > entry.reset_at) entry = { count: 0, reset_at: Date.now() + windowSec * 1000 };
  entry.count++;
  await env.INVITE_KV.put(key, JSON.stringify(entry), { expirationTtl: windowSec });
  return { allowed: entry.count <= max };
}

// ─────────────────────────────────────────────────────────────
// PUBLIC REDEMPTION
// ─────────────────────────────────────────────────────────────
async function handleRedeem(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') ?? '0.0.0.0';
  const rl = await checkRateLimit(env, `ratelimit:redeem:${ip}`, RL_REDEEM_MAX, RL_REDEEM_WIN_S);
  if (!rl.allowed) {
    await logAction(env, { action: 'redeem_rate_limited', ip, timestamp: now() });
    return htmlResponse(publicPageHTML(null, 'Too many attempts. Please wait 15 minutes and try again.'));
  }

  const form  = await request.formData();
  const email = sanitize(String(form.get('email') ?? ''));
  const code  = sanitize(String(form.get('code') ?? '')).toUpperCase().replace(/\s/g, '');

  if (!isValidEmail(email)) return htmlResponse(publicPageHTML(email, 'Please enter a valid email address.'));
  if (!code || code.length < 4 || code.length > 32)
    return htmlResponse(publicPageHTML(email, 'Please enter a valid invitation code.'));

  const [codeData] = await Promise.all([
    env.INVITE_KV.get(`code:${code}`).then(r => r ? JSON.parse(r) : null),
    sleep(150)
  ]);

  const genericError = 'This invitation code is not valid or has expired.';

  if (!codeData || !codeData.enabled) {
    await logAction(env, { action: 'redeem_fail', reason: 'invalid', email, code: obfuscate(code), ip, timestamp: now() });
    return htmlResponse(publicPageHTML(email, genericError));
  }
  if (codeData.expiration_date && Date.now() > new Date(codeData.expiration_date).getTime()) {
    await logAction(env, { action: 'redeem_fail', reason: 'expired', email, code: obfuscate(code), ip, timestamp: now() });
    return htmlResponse(publicPageHTML(email, genericError));
  }
  if (codeData.current_uses >= codeData.max_uses) {
    await logAction(env, { action: 'redeem_fail', reason: 'exhausted', email, code: obfuscate(code), ip, timestamp: now() });
    return htmlResponse(publicPageHTML(email, genericError));
  }

  codeData.current_uses++;
  codeData.redemptions = codeData.redemptions ?? [];
  codeData.redemptions.push({ email, ip, redeemed_at: now() });
  await saveCode(env, code, codeData);
  await logAction(env, { action: 'redeem_ok', email, code: obfuscate(code), ip, timestamp: now() });

  const canvaUrl = env.CANVA_INVITE_URL;
  if (!canvaUrl) return htmlResponse(publicPageHTML(email, 'Code accepted — contact your administrator for the class link.'));
  return new Response(null, { status: 302, headers: { Location: canvaUrl } });
}

// ─────────────────────────────────────────────────────────────
// ADMIN — DASHBOARD
// ─────────────────────────────────────────────────────────────
async function adminDashboard(request, env, session) {
  const [codeKeys, logKeys] = await Promise.all([listAllKeys(env, 'code:'), listAllKeys(env, 'log:')]);

  const codes = (await fetchValuesChunked(env, codeKeys.slice(0, 500))).filter(Boolean);
  const stats = {
    total:       codes.length,
    active:      codes.filter(c => c.enabled && !isExpired(c) && c.current_uses < c.max_uses).length,
    disabled:    codes.filter(c => !c.enabled).length,
    expired:     codes.filter(c => isExpired(c)).length,
    exhausted:   codes.filter(c => c.current_uses >= c.max_uses && !isExpired(c)).length,
    redemptions: codes.reduce((s, c) => s + (c.current_uses ?? 0), 0),
    total_logs:  logKeys.length
  };

  const recentLogKeys = logKeys.sort().reverse().slice(0, 10);
  const recentLogs    = await fetchValuesChunked(env, recentLogKeys);

  return htmlResponse(dashboardHTML(session, stats, recentLogs.filter(Boolean)));
}

// ─────────────────────────────────────────────────────────────
// ADMIN — CODES PAGE  (with filters + batch results panel)
// ─────────────────────────────────────────────────────────────
async function adminCodesPage(request, env, session) {
  const url      = new URL(request.url);
  const page     = Math.max(1, parseInt(url.searchParams.get('page') ?? '1'));
  const search   = (url.searchParams.get('q') ?? '').toUpperCase().trim();
  const statusF  = url.searchParams.get('status') ?? '';   // active|disabled|expired|full
  const batchId  = url.searchParams.get('batch') ?? '';

  // Load batch results if present
  let batchResult = null;
  if (batchId) {
    const raw = await env.INVITE_KV.get(`batch:${batchId}`);
    if (raw) batchResult = JSON.parse(raw);
  }

  // Load all keys
  let allKeys = await listAllKeys(env, 'code:');

  // Search filter (key-only, fast)
  if (search) allKeys = allKeys.filter(k => k.replace('code:', '').includes(search));

  // Status filter requires values — fetch all (up to 1000 for filter) then paginate
  let filteredKeys = allKeys;
  if (statusF) {
    const vals = await fetchValuesChunked(env, allKeys.slice(0, 1000));
    filteredKeys = allKeys.slice(0, 1000).filter((_, i) => {
      const c = vals[i];
      if (!c) return false;
      if (statusF === 'active')   return c.enabled && !isExpired(c) && c.current_uses < c.max_uses;
      if (statusF === 'disabled') return !c.enabled;
      if (statusF === 'expired')  return isExpired(c);
      if (statusF === 'full')     return c.current_uses >= c.max_uses;
      return true;
    });
  }

  const total      = filteredKeys.length;
  const totalPages = Math.ceil(total / CODE_PAGE) || 1;
  const pageKeys   = filteredKeys.slice((page - 1) * CODE_PAGE, page * CODE_PAGE);
  const pageVals   = await fetchValuesChunked(env, pageKeys);
  const codes = pageKeys.map((k, i) => pageVals[i] ? { key: k.replace('code:', ''), ...pageVals[i] } : null).filter(Boolean);

  return htmlResponse(codesPageHTML(session, codes, page, totalPages, search, statusF, total, batchResult));
}

// ─────────────────────────────────────────────────────────────
// ADMIN — CREATE SINGLE CODE
// ─────────────────────────────────────────────────────────────
async function handleCreateCode(request, env, session) {
  if (!await validateCSRF(request, session)) return htmlResponse(page403(), 403);

  const form = await request.formData();
  const { code, codeData, error } = buildCodeFromForm(form);
  if (error) return redirect(`/admin/codes?error=${enc(error)}`);

  const exists = await env.INVITE_KV.get(`code:${code}`);
  if (exists) return redirect(`/admin/codes?error=${enc('Code already exists: ' + code)}`);

  await saveCode(env, code, codeData);
  await logAction(env, { action: 'admin_create_code', code, by: session.username, timestamp: now() });

  return redirect('/admin/codes?success=Code+created+successfully');
}

// ─────────────────────────────────────────────────────────────
// ADMIN — BULK GENERATE  (the core enhanced feature)
// ─────────────────────────────────────────────────────────────
async function handleBulkCreate(request, env, session) {
  if (!await validateCSRF(request, session)) return htmlResponse(page403(), 403);

  const form    = await request.formData();
  const count   = Math.min(BULK_MAX, Math.max(1, parseInt(form.get('count')    ?? '10')));
  const length  = Math.min(16,       Math.max(4, parseInt(form.get('length')   ?? '8')));
  const maxUses = Math.min(10000,    Math.max(1, parseInt(form.get('max_uses') ?? '1')));
  const prefix  = sanitize(String(form.get('prefix') ?? '')).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const expDate = String(form.get('expiration_date') ?? '').trim();

  if (expDate && new Date(expDate).getTime() <= Date.now()) {
    return redirect('/admin/codes?error=Expiration+date+must+be+in+the+future');
  }

  // Build a Set of all existing code keys for instant duplicate detection
  const existingKeys = await listAllKeys(env, 'code:');
  const existingSet  = new Set(existingKeys.map(k => k.replace('code:', '')));

  const effectiveLen = Math.max(4, length - prefix.length);
  const created      = [];
  const generatedAt  = now();

  for (let i = 0; i < count; i++) {
    let code, attempts = 0;
    do {
      code = prefix + generateCode(effectiveLen);
      attempts++;
    } while ((existingSet.has(code) || created.includes(code)) && attempts < 20);

    if (!existingSet.has(code) && !created.includes(code)) {
      created.push(code);
    }
  }

  if (created.length === 0) {
    return redirect('/admin/codes?error=Failed+to+generate+unique+codes.+Try+a+longer+code+length.');
  }

  // Build code data template
  const buildEntry = (code) => ({
    created_at:      generatedAt,
    expiration_date: expDate || null,
    max_uses:        maxUses,
    current_uses:    0,
    enabled:         true,
    prefix,
    batch_generated: true,
    redemptions:     []
  });

  // Write to KV in parallel chunks — prevents CPU/network saturation
  const ttl = expDate
    ? Math.max(60, Math.floor((new Date(expDate).getTime() - Date.now()) / 1000) + 86400)
    : undefined;

  for (let i = 0; i < created.length; i += KV_WRITE_CHUNK) {
    const chunk = created.slice(i, i + KV_WRITE_CHUNK);
    await Promise.all(chunk.map(code => {
      const opts = ttl ? { expirationTtl: ttl } : undefined;
      return env.INVITE_KV.put(`code:${code}`, JSON.stringify(buildEntry(code)), opts);
    }));
  }

  // Store batch result (2 h TTL) — used to render the results panel
  const batchId = hexRand(12);
  const batchResult = {
    batch_id:     batchId,
    generated_at: generatedAt,
    count:        created.length,
    params:       { prefix, length, max_uses: maxUses, expiration_date: expDate || null },
    codes:        created
  };
  await env.INVITE_KV.put(`batch:${batchId}`, JSON.stringify(batchResult), { expirationTtl: BATCH_TTL_S });

  await logAction(env, {
    action: 'admin_bulk_create',
    count:  created.length,
    batch_id: batchId,
    by: session.username,
    timestamp: generatedAt
  });

  return redirect(`/admin/codes?batch=${batchId}&success=${enc(`${created.length} codes generated successfully`)}`);
}

// ─────────────────────────────────────────────────────────────
// ADMIN — TOGGLE / DELETE CODE
// ─────────────────────────────────────────────────────────────
async function handleToggleCode(request, env, session) {
  if (!await validateCSRF(request, session)) return htmlResponse(page403(), 403);
  const form = await request.formData();
  const code = sanitize(String(form.get('code') ?? '')).toUpperCase();
  const raw  = await env.INVITE_KV.get(`code:${code}`);
  if (!raw) return redirect('/admin/codes?error=Code+not+found');
  const codeData   = JSON.parse(raw);
  codeData.enabled = !codeData.enabled;
  await env.INVITE_KV.put(`code:${code}`, JSON.stringify(codeData));
  await logAction(env, { action: codeData.enabled ? 'admin_enable_code' : 'admin_disable_code', code, by: session.username, timestamp: now() });
  const ref = request.headers.get('Referer') ?? '/admin/codes';
  return redirect(ref.includes('/admin/') ? ref : '/admin/codes');
}

async function handleDeleteCode(request, env, session) {
  if (!await validateCSRF(request, session)) return htmlResponse(page403(), 403);
  const form = await request.formData();
  const code = sanitize(String(form.get('code') ?? '')).toUpperCase();
  await env.INVITE_KV.delete(`code:${code}`);
  await logAction(env, { action: 'admin_delete_code', code, by: session.username, timestamp: now() });
  return redirect('/admin/codes?success=Code+deleted');
}

// ─────────────────────────────────────────────────────────────
// ADMIN — EXPORT  (server-side for very large batches)
// ─────────────────────────────────────────────────────────────
async function handleExport(request, env, session) {
  const url     = new URL(request.url);
  const format  = url.searchParams.get('format') ?? 'txt'; // txt | csv
  const batchId = url.searchParams.get('batch') ?? '';

  let codes = [];

  if (batchId) {
    const raw = await env.INVITE_KV.get(`batch:${batchId}`);
    if (raw) {
      const batch = JSON.parse(raw);
      codes = batch.codes.map(c => ({
        code: c,
        max_uses: batch.params.max_uses,
        expiration_date: batch.params.expiration_date ?? ''
      }));
    }
  } else {
    // Export all codes
    const keys = await listAllKeys(env, 'code:');
    const vals = await fetchValuesChunked(env, keys);
    codes = keys.map((k, i) => vals[i] ? {
      code: k.replace('code:', ''),
      max_uses: vals[i].max_uses,
      expiration_date: vals[i].expiration_date ?? ''
    } : null).filter(Boolean);
  }

  if (format === 'csv') {
    const rows = ['code,max_uses,expiration_date', ...codes.map(c =>
      `${c.code},${c.max_uses},${c.expiration_date}`
    )];
    return new Response(rows.join('\n'), {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="invite-codes-${Date.now()}.csv"`
      }
    });
  }

  const lines = codes.map(c => c.code);
  return new Response(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/plain',
      'Content-Disposition': `attachment; filename="invite-codes-${Date.now()}.txt"`
    }
  });
}

// ─────────────────────────────────────────────────────────────
// ADMIN — LOGS
// ─────────────────────────────────────────────────────────────
async function adminLogsPage(request, env, session) {
  const url    = new URL(request.url);
  const page   = Math.max(1, parseInt(url.searchParams.get('page') ?? '1'));
  const filter = url.searchParams.get('action') ?? '';

  let keys = (await listAllKeys(env, 'log:')).sort().reverse();

  if (filter) {
    const sample = await fetchValuesChunked(env, keys.slice(0, 600));
    const filtered = sample.filter(l => l && l.action === filter);
    const total    = filtered.length;
    const logs     = filtered.slice((page - 1) * LOG_PAGE, page * LOG_PAGE);
    return htmlResponse(logsPageHTML(session, logs, page, Math.ceil(total / LOG_PAGE) || 1, filter, total));
  }

  const total    = keys.length;
  const pageKeys = keys.slice((page - 1) * LOG_PAGE, page * LOG_PAGE);
  const logs     = await fetchValuesChunked(env, pageKeys);

  return htmlResponse(logsPageHTML(session, logs.filter(Boolean), page, Math.ceil(total / LOG_PAGE) || 1, filter, total));
}

// ─────────────────────────────────────────────────────────────
// KV HELPERS
// ─────────────────────────────────────────────────────────────
async function listAllKeys(env, prefix) {
  const keys = [];
  let cursor;
  do {
    const res = await env.INVITE_KV.list(cursor ? { prefix, cursor } : { prefix });
    keys.push(...res.keys.map(k => k.name));
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  return keys;
}

async function fetchValuesChunked(env, keys) {
  const results = new Array(keys.length).fill(null);
  for (let i = 0; i < keys.length; i += KV_WRITE_CHUNK) {
    const chunk   = keys.slice(i, i + KV_WRITE_CHUNK);
    const fetched = await Promise.all(chunk.map(k => env.INVITE_KV.get(k).then(r => r ? JSON.parse(r) : null)));
    fetched.forEach((v, j) => { results[i + j] = v; });
  }
  return results;
}

async function saveCode(env, code, codeData) {
  const ttl = codeData.expiration_date
    ? Math.max(60, Math.floor((new Date(codeData.expiration_date).getTime() - Date.now()) / 1000) + 86400)
    : undefined;
  await env.INVITE_KV.put(`code:${code}`, JSON.stringify(codeData), ttl ? { expirationTtl: ttl } : undefined);
}

async function logAction(env, entry) {
  try {
    const key = `log:${String(Date.now()).padStart(15, '0')}:${hexRand(4)}`;
    await env.INVITE_KV.put(key, JSON.stringify(entry), { expirationTtl: 90 * 86400 });
  } catch (_) { /* non-fatal */ }
}

// ─────────────────────────────────────────────────────────────
// CODE GENERATION
// ─────────────────────────────────────────────────────────────
function generateCode(length) {
  const buf  = crypto.getRandomValues(new Uint8Array(length * 3));
  let   code = '';
  for (let i = 0; i < buf.length && code.length < length; i++) {
    const idx = buf[i] % CHARSET.length;
    code += CHARSET[idx];
  }
  return code.slice(0, length);
}

function buildCodeFromForm(form) {
  const prefix     = sanitize(String(form.get('prefix') ?? '')).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const length     = Math.min(16, Math.max(4, parseInt(form.get('length') ?? '8')));
  const maxUses    = Math.min(10000, Math.max(1, parseInt(form.get('max_uses') ?? '1')));
  const expDate    = String(form.get('expiration_date') ?? '').trim();
  const customCode = sanitize(String(form.get('custom_code') ?? '')).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (expDate && new Date(expDate).getTime() <= Date.now()) return { error: 'Expiration date must be in the future.' };
  const code = customCode || (prefix + generateCode(Math.max(4, length - prefix.length)));
  if (code.length < 4) return { error: 'Code must be at least 4 characters.' };
  return { code, codeData: { created_at: now(), expiration_date: expDate || null, max_uses: maxUses, current_uses: 0, enabled: true, prefix, redemptions: [] } };
}

// ─────────────────────────────────────────────────────────────
// CRYPTO
// ─────────────────────────────────────────────────────────────
async function signToken(token, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret ?? 'fallback'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(token));
  return `${token}.${bufToHex(sig)}`;
}

async function verifySignedToken(signed, secret) {
  const dot = signed.lastIndexOf('.');
  if (dot < 1) return null;
  const token = signed.slice(0, dot);
  const sig   = signed.slice(dot + 1);
  const enc   = new TextEncoder();
  const key   = await crypto.subtle.importKey('raw', enc.encode(secret ?? 'fallback'), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  try {
    return await crypto.subtle.verify('HMAC', key, hexToBuf(sig), enc.encode(token)) ? token : null;
  } catch (_) { return null; }
}

async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b)))
  ]);
  const [va, vb] = [new Uint8Array(da), new Uint8Array(db)];
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

// ─────────────────────────────────────────────────────────────
// MISC UTILITIES
// ─────────────────────────────────────────────────────────────
function hexRand(bytes) { return bufToHex(crypto.getRandomValues(new Uint8Array(bytes))); }
function bufToHex(b)    { return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2,'0')).join(''); }
function hexToBuf(hex)  { const a = new Uint8Array(hex.length/2); for(let i=0;i<a.length;i++) a[i]=parseInt(hex.slice(i*2,i*2+2),16); return a.buffer; }
function now()          { return new Date().toISOString(); }
function sleep(ms)      { return new Promise(r => setTimeout(r, ms)); }
function sanitize(s)    { return String(s).slice(0, 300).replace(/[<>"'`]/g, ''); }
function enc(s)         { return encodeURIComponent(String(s)); }
function isValidEmail(e){ return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length < 200; }
function isExpired(c)   { return !!(c.expiration_date && Date.now() > new Date(c.expiration_date).getTime()); }
function obfuscate(c)   { return c.length <= 4 ? '****' : c.slice(0,2)+'****'+c.slice(-2); }
function htmlResponse(body, status = 200) { return new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } }); }
function redirect(url)  { return new Response(null, { status: 302, headers: { Location: url } }); }

function e(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function statusBadge(code) {
  if (!code.enabled)                        return `<span class="badge badge-off">Disabled</span>`;
  if (isExpired(code))                      return `<span class="badge badge-exp">Expired</span>`;
  if (code.current_uses >= code.max_uses)   return `<span class="badge badge-ful">Full</span>`;
  return `<span class="badge badge-on">Active</span>`;
}

function formatDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC'; }
  catch (_) { return iso; }
}

function actionLabel(action) {
  const m = { redeem_ok:'✅ Redeemed', redeem_fail:'❌ Failed', redeem_rate_limited:'🚫 Rate Limited',
    admin_login_ok:'🔐 Admin Login', admin_login_fail:'⛔ Login Failed', admin_create_code:'➕ Code Created',
    admin_bulk_create:'📦 Bulk Created', admin_delete_code:'🗑️ Deleted', admin_enable_code:'✔️ Enabled',
    admin_disable_code:'🔕 Disabled' };
  return m[action] ?? action;
}

// ─────────────────────────────────────────────────────────────
// SHARED STYLES
// ─────────────────────────────────────────────────────────────
const GF = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;0,9..40,800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">`;

const BASE_CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg:      #0b0c14; --surface: #13141e; --card:    #191b27;
  --border:  #252836; --accent:  #7c5cfc; --accent2: #00d4aa;
  --danger:  #f0476b; --warn:    #f5a623; --info:    #3b9eff;
  --text:    #e4e6f0; --muted:   #6b7090; --input:   #1e2030;
  --radius:  10px;    --font:    'DM Sans', system-ui, sans-serif;
  --mono:    'JetBrains Mono', 'Fira Code', monospace;
}
html { font-family: var(--font); color: var(--text); background: var(--bg); }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
input, select, textarea {
  background: var(--input); color: var(--text); border: 1px solid var(--border);
  border-radius: 6px; padding: 9px 12px; font-family: var(--font); font-size: 13px;
  width: 100%; outline: none; transition: border-color .15s, box-shadow .15s;
}
input:focus, select:focus, textarea:focus {
  border-color: var(--accent); box-shadow: 0 0 0 3px rgba(124,92,252,.18);
}
label { font-size: 12px; color: var(--muted); display: block; margin-bottom: 5px; font-weight: 600; letter-spacing:.03em; text-transform:uppercase; }
.btn {
  display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
  border: none; border-radius: 6px; padding: 9px 16px;
  font-family: var(--font); font-size: 13px; font-weight: 600;
  transition: opacity .15s, transform .1s; white-space: nowrap;
}
.btn:hover { opacity: .87; transform: translateY(-1px); }
.btn:active { transform: translateY(0); opacity: 1; }
.btn-primary   { background: var(--accent); color: #fff; }
.btn-secondary { background: var(--card); color: var(--text); border: 1px solid var(--border); }
.btn-danger    { background: var(--danger); color: #fff; }
.btn-success   { background: var(--accent2); color: #06110e; }
.btn-info      { background: var(--info); color: #fff; }
.btn-sm { padding: 5px 11px; font-size: 12px; }
.btn-xs { padding: 3px 8px; font-size: 11px; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 11px; font-weight: 700; }
.badge-on  { background: rgba(0,212,170,.13); color: var(--accent2); }
.badge-off { background: rgba(107,112,144,.13); color: var(--muted); }
.badge-exp { background: rgba(245,166,35,.13); color: var(--warn); }
.badge-ful { background: rgba(240,71,107,.13); color: var(--danger); }
.alert { padding: 11px 15px; border-radius: var(--radius); font-size: 13px; margin-bottom: 18px; }
.alert-error   { background: rgba(240,71,107,.1); border: 1px solid rgba(240,71,107,.3); color: #f88ea0; }
.alert-success { background: rgba(0,212,170,.1); border: 1px solid rgba(0,212,170,.3); color: var(--accent2); }
.alert-info    { background: rgba(59,158,255,.1); border: 1px solid rgba(59,158,255,.3); color: var(--info); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; padding: 9px 13px; color: var(--muted); font-weight: 700;
     font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
     border-bottom: 1px solid var(--border); white-space: nowrap; }
td { padding: 10px 13px; border-bottom: 1px solid var(--border); vertical-align: middle; }
tr:last-child td { border-bottom: none; }
tr:hover td { background: rgba(255,255,255,.015); }
code { font-family: var(--mono); background: var(--input); padding: 2px 7px; border-radius: 4px; font-size: 12px; letter-spacing:.04em; }
`;

// ─────────────────────────────────────────────────────────────
// ADMIN SHELL
// ─────────────────────────────────────────────────────────────
function adminShell(session, activeTab, content, extraHead = '') {
  const csrf = session.csrf_token;
  const nav = [
    { href: '/admin/dashboard', label: 'Dashboard',    icon: '◈', id: 'dashboard' },
    { href: '/admin/codes',     label: 'Invite Codes', icon: '⊞', id: 'codes'     },
    { href: '/admin/logs',      label: 'Logs',         icon: '◷', id: 'logs'      },
  ];
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Invite Admin</title>${GF}
${extraHead}
<style>
${BASE_CSS}
body { display:flex; min-height:100vh; }
.sidebar {
  width: 220px; min-height:100vh; background: var(--surface); border-right:1px solid var(--border);
  display:flex; flex-direction:column; padding:0; flex-shrink:0; position:sticky; top:0; height:100vh; overflow:auto;
}
.sidebar-logo {
  padding: 22px 20px 20px; border-bottom:1px solid var(--border);
  font-weight:800; font-size:15px; letter-spacing:-.03em; color: var(--text);
}
.sidebar-logo em { color: var(--accent); font-style:normal; }
.sidebar-nav { padding:12px 10px; flex:1; }
.sidebar-nav a {
  display:flex; align-items:center; gap:9px; padding:9px 11px;
  border-radius:7px; color: var(--muted); font-size:13px; font-weight:600;
  transition: background .12s, color .12s; margin-bottom:3px;
}
.sidebar-nav a:hover { background: var(--card); color: var(--text); text-decoration:none; }
.sidebar-nav a.active { background: rgba(124,92,252,.15); color: var(--accent); }
.sidebar-nav a .icon { width:18px; text-align:center; font-size:14px; }
.sidebar-footer { padding:14px 16px; border-top:1px solid var(--border); }
.main { flex:1; display:flex; flex-direction:column; overflow:auto; min-width:0; }
.topbar {
  background: var(--surface); border-bottom:1px solid var(--border);
  padding:15px 28px; display:flex; justify-content:space-between; align-items:center;
  position:sticky; top:0; z-index:10;
}
.topbar-title { font-size:17px; font-weight:800; letter-spacing:-.02em; }
.content { padding:26px 28px; flex:1; }
.card { background: var(--card); border:1px solid var(--border); border-radius:var(--radius); padding:22px; margin-bottom:20px; }
.card-title { font-size:14px; font-weight:700; margin-bottom:14px; letter-spacing:-.01em; }
.card-title small { color: var(--muted); font-weight:500; font-size:12px; }
.stats-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(140px,1fr)); gap:14px; margin-bottom:20px; }
.stat-card { background: var(--card); border:1px solid var(--border); border-radius:var(--radius); padding:18px 20px; }
.stat-val { font-size:28px; font-weight:800; line-height:1; letter-spacing:-.03em; }
.stat-label { font-size:11px; color: var(--muted); margin-top:5px; text-transform:uppercase; letter-spacing:.07em; font-weight:600; }
.form-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(160px,1fr)); gap:14px; }
.form-group { display:flex; flex-direction:column; }
.action-row { display:flex; gap:5px; flex-wrap:wrap; }
.pagination { display:flex; gap:8px; align-items:center; margin-top:18px; font-size:13px; color:var(--muted); flex-wrap:wrap; }
.pagination a { color: var(--accent); }
.chip {
  display:inline-flex; align-items:center; gap:5px; padding:4px 10px;
  border-radius:20px; font-size:12px; font-weight:600; cursor:pointer;
  background: var(--card); border:1px solid var(--border); color: var(--muted);
  transition: background .12s, color .12s, border-color .12s;
}
.chip.active, .chip:hover { background: rgba(124,92,252,.15); color: var(--accent); border-color: rgba(124,92,252,.4); }
</style>
</head><body>
<aside class="sidebar">
  <div class="sidebar-logo">Invite<em>Admin</em></div>
  <nav class="sidebar-nav">
    ${nav.map(n=>`<a href="${n.href}" class="${activeTab===n.id?'active':''}"><span class="icon">${n.icon}</span>${n.label}</a>`).join('')}
  </nav>
  <div class="sidebar-footer">
    <form method="POST" action="/admin/logout">
      <input type="hidden" name="_csrf" value="${e(csrf)}">
      <button class="btn btn-secondary btn-sm" style="width:100%">↩ Sign Out</button>
    </form>
  </div>
</aside>
<main class="main">${content}</main>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────
// PUBLIC PAGE
// ─────────────────────────────────────────────────────────────
function publicPageHTML(email = '', errorMsg = '') {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Join Canva Education Class</title>${GF}
<style>
${BASE_CSS}
body { min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:24px; }
body::before {
  content:''; position:fixed; inset:0; z-index:-1;
  background: radial-gradient(ellipse 90% 70% at 50% -5%, rgba(124,92,252,.22) 0%, transparent 65%);
}
.card {
  background: var(--card); border:1px solid var(--border); border-radius:18px;
  padding:46px 42px; width:100%; max-width:430px; box-shadow:0 20px 60px rgba(0,0,0,.55);
}
.logo { font-size:28px; font-weight:800; letter-spacing:-.04em; margin-bottom:5px; }
.logo em { color: var(--accent); font-style:normal; }
.sub { color: var(--muted); font-size:13px; margin-bottom:34px; line-height:1.5; }
.form-group { margin-bottom:16px; }
.submit-btn {
  width:100%; padding:13px; font-size:14px; margin-top:6px;
  background: var(--accent); color:#fff; border:none; border-radius:8px;
  font-family: var(--font); font-weight:700; cursor:pointer;
  transition: opacity .15s, transform .1s;
}
.submit-btn:hover { opacity:.88; transform:translateY(-1px); }
.footer-note { text-align:center; color:var(--muted); font-size:11px; margin-top:18px; line-height:1.7; }
@keyframes shake { 0%,100%{transform:translateX(0)} 20%,60%{transform:translateX(-5px)} 40%,80%{transform:translateX(5px)} }
.has-error { animation: shake .35s ease; }
</style></head><body>
<div class="card ${errorMsg?'has-error':''}">
  <div class="logo">Class<em>Pass</em></div>
  <p class="sub">Enter your details below to join the Canva Education class.</p>
  ${errorMsg ? `<div class="alert alert-error">${e(errorMsg)}</div>` : ''}
  <form method="POST" action="/redeem" autocomplete="off">
    <div class="form-group">
      <label for="email">Email address</label>
      <input type="email" id="email" name="email" required placeholder="you@school.edu" value="${e(email)}" autocomplete="email">
    </div>
    <div class="form-group">
      <label for="code">Invitation code</label>
      <input type="text" id="code" name="code" required placeholder="e.g. EDU-ABCD1234"
        autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false"
        style="font-family:var(--mono);letter-spacing:.1em">
    </div>
    <button type="submit" class="submit-btn">Redeem &amp; Join →</button>
  </form>
  <p class="footer-note">Codes are single-use unless configured otherwise.<br>Contact your instructor for assistance.</p>
</div>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────
// LOGIN PAGE
// ─────────────────────────────────────────────────────────────
function loginPageHTML(errorMsg = '') {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin Login</title>${GF}
<style>
${BASE_CSS}
body { min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; }
.card { background: var(--card); border:1px solid var(--border); border-radius:18px; padding:42px 38px; width:100%; max-width:370px; box-shadow:0 16px 50px rgba(0,0,0,.5); }
.logo { font-size:22px; font-weight:800; letter-spacing:-.03em; margin-bottom:4px; }
.logo em { color: var(--accent); font-style:normal; }
.sub { color: var(--muted); font-size:13px; margin-bottom:28px; }
.form-group { margin-bottom:14px; }
.submit-btn { width:100%; padding:11px; background: var(--accent); color:#fff; border:none; border-radius:7px; font-family:var(--font); font-size:14px; font-weight:700; cursor:pointer; margin-top:4px; transition:opacity .15s; }
.submit-btn:hover { opacity:.88; }
</style></head><body>
<div class="card">
  <div class="logo">Invite<em>Admin</em></div>
  <p class="sub">Secure administrator access</p>
  ${errorMsg ? `<div class="alert alert-error">${e(errorMsg)}</div>` : ''}
  <form method="POST" action="/admin/login" autocomplete="off">
    <div class="form-group">
      <label>Username</label>
      <input type="text" name="username" required autocomplete="username">
    </div>
    <div class="form-group">
      <label>Password</label>
      <input type="password" name="password" required autocomplete="current-password">
    </div>
    <button type="submit" class="submit-btn">Sign In →</button>
  </form>
</div>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────────────────────
function dashboardHTML(session, stats, recentLogs) {
  const content = `
<div class="topbar">
  <span class="topbar-title">Dashboard</span>
  <span style="color:var(--muted);font-size:13px">Signed in as <strong>${e(session.username)}</strong></span>
</div>
<div class="content">
  <div class="stats-grid">
    ${sc(stats.total,       'Total Codes',  '#7c5cfc')}
    ${sc(stats.active,      'Active',       '#00d4aa')}
    ${sc(stats.redemptions, 'Redeemed',     '#7c5cfc')}
    ${sc(stats.disabled,    'Disabled',     '#6b7090')}
    ${sc(stats.expired,     'Expired',      '#f5a623')}
    ${sc(stats.exhausted,   'Full',         '#f0476b')}
  </div>
  <div class="card">
    <div class="card-title">Recent Activity</div>
    <table>
      <thead><tr><th>Time</th><th>Action</th><th>Email / Code</th><th>IP</th></tr></thead>
      <tbody>
        ${recentLogs.length
          ? recentLogs.map(l => `<tr>
              <td style="font-size:11px;color:var(--muted);white-space:nowrap">${e(l.timestamp??'')}</td>
              <td>${actionLabel(l.action??'')}</td>
              <td style="font-size:12px">${e(l.email??l.code??'—')}</td>
              <td style="font-size:11px;color:var(--muted)">${e(l.ip??'—')}</td>
            </tr>`).join('')
          : `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:28px">No activity yet</td></tr>`}
      </tbody>
    </table>
    <div style="margin-top:14px"><a href="/admin/logs">View all logs →</a></div>
  </div>
</div>`;
  return adminShell(session, 'dashboard', content);
}

function sc(val, label, color) {
  return `<div class="stat-card"><div class="stat-val" style="color:${color}">${val}</div><div class="stat-label">${label}</div></div>`;
}

// ─────────────────────────────────────────────────────────────
// CODES PAGE  ← main enhanced section
// ─────────────────────────────────────────────────────────────
function codesPageHTML(session, codes, page, totalPages, search, statusFilter, total, batchResult) {
  const csrf = session.csrf_token;
  const qParts = [];
  if (search)       qParts.push(`q=${enc(search)}`);
  if (statusFilter) qParts.push(`status=${enc(statusFilter)}`);
  const qs = qParts.length ? '&' + qParts.join('&') : '';

  const statuses = [
    { val: '',         label: 'All Statuses' },
    { val: 'active',   label: '✅ Active' },
    { val: 'disabled', label: '🔕 Disabled' },
    { val: 'expired',  label: '⌛ Expired' },
    { val: 'full',     label: '🔴 Full' },
  ];

  const extraHead = `
<style>
/* ── Batch Results Panel ── */
.batch-panel {
  background: linear-gradient(135deg, rgba(124,92,252,.08) 0%, rgba(0,212,170,.06) 100%);
  border: 1px solid rgba(124,92,252,.35); border-radius: var(--radius);
  padding: 22px; margin-bottom: 22px;
}
.batch-header {
  display: flex; justify-content: space-between; align-items: flex-start;
  margin-bottom: 16px; gap: 12px; flex-wrap: wrap;
}
.batch-meta { display: flex; gap: 20px; flex-wrap: wrap; font-size: 12px; color: var(--muted); margin-top: 6px; }
.batch-meta span strong { color: var(--text); }
.batch-toolbar {
  display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; align-items: center;
}
.sel-info { font-size: 12px; color: var(--muted); padding: 5px 10px; }
.codes-area {
  background: var(--input); border: 1px solid var(--border); border-radius: 7px;
  max-height: 320px; overflow-y: auto; padding: 0;
}
.code-list { list-style: none; }
.code-item {
  display: flex; align-items: center; gap: 10px; padding: 8px 14px;
  border-bottom: 1px solid var(--border); transition: background .1s;
}
.code-item:last-child { border-bottom: none; }
.code-item:hover { background: rgba(255,255,255,.03); }
.code-item input[type=checkbox] {
  width: 15px; height: 15px; flex-shrink: 0; cursor: pointer;
  accent-color: var(--accent); margin: 0;
}
.code-item .code-val {
  font-family: var(--mono); font-size: 13px; letter-spacing: .08em;
  flex: 1; user-select: all;
}
.code-item .copy-one {
  opacity: 0; transition: opacity .15s; cursor: pointer; font-size: 11px;
  color: var(--muted); background: none; border: none; padding: 3px 6px;
  border-radius: 4px; font-family: var(--font);
}
.code-item:hover .copy-one { opacity: 1; }
.code-item .copy-one:hover { background: var(--card); color: var(--text); }
.copied-flash { color: var(--accent2) !important; }
/* ── Filters bar ── */
.filters-bar {
  display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
  padding: 14px 0 16px; border-bottom: 1px solid var(--border); margin-bottom: 16px;
}
.filters-bar form { display: contents; }
/* ── Table actions ── */
.table-wrap { overflow-x: auto; }
</style>`;

  // ── Batch results panel
  let batchPanel = '';
  if (batchResult && batchResult.codes && batchResult.codes.length) {
    const bp = batchResult;
    const batchQs = `batch=${e(bp.batch_id)}`;
    const codeListItems = bp.codes.map((c, i) =>
      `<li class="code-item">
        <input type="checkbox" class="code-cb" data-code="${e(c)}" id="cb${i}">
        <label for="cb${i}" class="code-val" style="cursor:pointer">${e(c)}</label>
        <button class="copy-one" onclick="copyOne('${e(c)}', this)" title="Copy">Copy</button>
      </li>`
    ).join('');

    batchPanel = `
<div class="batch-panel" id="batchPanel">
  <div class="batch-header">
    <div>
      <div style="font-size:15px;font-weight:700;letter-spacing:-.01em">
        📦 Batch Generated — <span style="color:var(--accent)">${bp.codes.length} codes</span>
      </div>
      <div class="batch-meta">
        <span>🕐 <strong>${e(formatDate(bp.generated_at))}</strong></span>
        ${bp.params.prefix ? `<span>Prefix: <strong>${e(bp.params.prefix)}</strong></span>` : ''}
        <span>Max uses: <strong>${bp.params.max_uses}</strong></span>
        <span>Expires: <strong>${bp.params.expiration_date ? e(formatDate(bp.params.expiration_date)) : 'Never'}</strong></span>
      </div>
    </div>
    <button class="btn btn-secondary btn-sm" onclick="document.getElementById('batchPanel').remove()">✕ Dismiss</button>
  </div>

  <div class="batch-toolbar">
    <button class="btn btn-secondary btn-sm" onclick="selectAll()">☑ Select All</button>
    <button class="btn btn-secondary btn-sm" onclick="deselectAll()">☐ Deselect All</button>
    <span class="sel-info" id="selInfo">0 selected</span>
    <div style="flex:1"></div>
    <button class="btn btn-success btn-sm" onclick="copyAll()">⎘ Copy All</button>
    <button class="btn btn-secondary btn-sm" onclick="copySelected()">⎘ Copy Selected</button>
    <a href="/admin/codes/export?format=txt&${batchQs}" class="btn btn-secondary btn-sm">⬇ TXT</a>
    <a href="/admin/codes/export?format=csv&${batchQs}" class="btn btn-secondary btn-sm">⬇ CSV</a>
  </div>

  <div class="codes-area">
    <ul class="code-list" id="codeList">${codeListItems}</ul>
  </div>

  <div style="margin-top:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
    <span id="copyStatus" style="font-size:12px;color:var(--accent2);min-height:18px"></span>
    <div style="flex:1"></div>
    <a href="/admin/codes/export?format=txt" class="btn btn-secondary btn-xs">⬇ Export All Codes (.txt)</a>
    <a href="/admin/codes/export?format=csv" class="btn btn-secondary btn-xs">⬇ Export All Codes (.csv)</a>
  </div>
</div>

<script>
// ── Batch panel JS ────────────────────────────────────────────
const ALL_CODES = ${JSON.stringify(bp.codes)};

function updateSelInfo() {
  const n = document.querySelectorAll('.code-cb:checked').length;
  document.getElementById('selInfo').textContent = n + ' selected';
}
document.getElementById('codeList').addEventListener('change', updateSelInfo);

function selectAll() {
  document.querySelectorAll('.code-cb').forEach(cb => cb.checked = true);
  updateSelInfo();
}
function deselectAll() {
  document.querySelectorAll('.code-cb').forEach(cb => cb.checked = false);
  updateSelInfo();
}

function showCopyStatus(msg) {
  const el = document.getElementById('copyStatus');
  el.textContent = msg;
  setTimeout(() => { el.textContent = ''; }, 2500);
}

function copyToClipboard(text, onDone) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(onDone).catch(() => fallbackCopy(text, onDone));
  } else {
    fallbackCopy(text, onDone);
  }
}
function fallbackCopy(text, onDone) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch(_) {}
  document.body.removeChild(ta);
  if (onDone) onDone();
}

function copyAll() {
  const text = ALL_CODES.join('\\n');
  copyToClipboard(text, () => showCopyStatus('✅ Copied ' + ALL_CODES.length + ' codes to clipboard'));
}

function copySelected() {
  const checked = [...document.querySelectorAll('.code-cb:checked')].map(cb => cb.dataset.code);
  if (!checked.length) { showCopyStatus('⚠ No codes selected'); return; }
  copyToClipboard(checked.join('\\n'), () => showCopyStatus('✅ Copied ' + checked.length + ' codes to clipboard'));
}

function copyOne(code, btn) {
  copyToClipboard(code, () => {
    const orig = btn.textContent;
    btn.textContent = '✓';
    btn.classList.add('copied-flash');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied-flash'); }, 1500);
  });
}
// Keyboard shortcut: Ctrl+C / Cmd+C when focused on list copies selected
</script>`;
  }

  // ── Filter chips
  const filterChips = statuses.map(s => {
    const params = new URLSearchParams();
    if (search) params.set('q', search);
    if (s.val) params.set('status', s.val);
    const isActive = statusFilter === s.val;
    return `<a href="/admin/codes${params.toString()?'?'+params:''}" class="chip ${isActive?'active':''}">${s.label}</a>`;
  }).join('');

  // ── Toolbar with search
  const searchBar = `
<form method="GET" action="/admin/codes" style="display:flex;gap:8px;align-items:center">
  ${statusFilter ? `<input type="hidden" name="status" value="${e(statusFilter)}">` : ''}
  <input type="text" name="q" value="${e(search)}" placeholder="Search codes…" style="width:180px">
  <button class="btn btn-secondary btn-sm" type="submit">Search</button>
  ${(search || statusFilter) ? `<a href="/admin/codes" class="btn btn-secondary btn-sm">Clear</a>` : ''}
</form>`;

  const content = `
<div class="topbar">
  <span class="topbar-title">Invite Codes <span style="color:var(--muted);font-size:13px;font-weight:400">(${total} ${statusFilter ? statusFilter : 'total'})</span></span>
  <div style="display:flex;gap:8px;align-items:center">
    <a href="/admin/codes/export?format=csv" class="btn btn-secondary btn-sm">⬇ Export All CSV</a>
    <a href="/admin/codes/export?format=txt" class="btn btn-secondary btn-sm">⬇ Export All TXT</a>
  </div>
</div>
<div class="content">
  ${flashScript()}
  ${batchPanel}

  <!-- Create Single Code -->
  <div class="card">
    <div class="card-title">Create Single Code <small>— one-off or custom codes</small></div>
    <form method="POST" action="/admin/codes/create">
      <input type="hidden" name="_csrf" value="${e(csrf)}">
      <div class="form-grid">
        <div class="form-group">
          <label>Custom code <span style="font-weight:400;text-transform:none">(leave blank to auto-generate)</span></label>
          <input type="text" name="custom_code" placeholder="e.g. TEACHER2025" style="font-family:var(--mono);text-transform:uppercase" maxlength="32">
        </div>
        <div class="form-group">
          <label>Prefix <span style="font-weight:400;text-transform:none">(auto-gen only, max 6)</span></label>
          <input type="text" name="prefix" placeholder="e.g. EDU" maxlength="6" style="font-family:var(--mono);text-transform:uppercase">
        </div>
        <div class="form-group">
          <label>Length <span style="font-weight:400;text-transform:none">(4–16)</span></label>
          <input type="number" name="length" value="8" min="4" max="16">
        </div>
        <div class="form-group">
          <label>Max uses</label>
          <input type="number" name="max_uses" value="1" min="1" max="10000">
        </div>
        <div class="form-group">
          <label>Expiration <span style="font-weight:400;text-transform:none">(optional)</span></label>
          <input type="datetime-local" name="expiration_date">
        </div>
      </div>
      <div style="margin-top:4px">
        <button type="submit" class="btn btn-primary">➕ Create Code</button>
      </div>
    </form>
  </div>

  <!-- Bulk Generate -->
  <div class="card" id="bulkCard">
    <div class="card-title">Bulk Generate Codes <small>— up to ${BULK_MAX} per batch</small></div>
    <form method="POST" action="/admin/codes/bulk" id="bulkForm">
      <input type="hidden" name="_csrf" value="${e(csrf)}">
      <div class="form-grid">
        <div class="form-group">
          <label>Number of codes</label>
          <input type="number" name="count" id="bulkCount" value="10" min="1" max="${BULK_MAX}" required>
        </div>
        <div class="form-group">
          <label>Code length <span style="font-weight:400;text-transform:none">(4–16)</span></label>
          <input type="number" name="length" value="8" min="4" max="16" required>
        </div>
        <div class="form-group">
          <label>Prefix <span style="font-weight:400;text-transform:none">(optional, max 6)</span></label>
          <input type="text" name="prefix" placeholder="e.g. EDU" maxlength="6" style="font-family:var(--mono);text-transform:uppercase">
        </div>
        <div class="form-group">
          <label>Max uses per code</label>
          <input type="number" name="max_uses" value="1" min="1" max="10000" required>
        </div>
        <div class="form-group">
          <label>Expiration <span style="font-weight:400;text-transform:none">(optional)</span></label>
          <input type="datetime-local" name="expiration_date">
        </div>
      </div>
      <div style="margin-top:4px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <button type="submit" class="btn btn-primary" id="bulkSubmit">📦 Generate Codes</button>
        <span id="bulkHint" style="font-size:12px;color:var(--muted)"></span>
      </div>
    </form>
  </div>

  <!-- Code List with Filters -->
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:4px">
      <div class="card-title" style="margin-bottom:0">All Codes</div>
      ${searchBar}
    </div>
    <div class="filters-bar">
      ${filterChips}
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Code</th><th>Status</th><th>Uses</th><th>Expiration</th><th>Created</th><th>Actions</th>
        </tr></thead>
        <tbody>
          ${codes.length
            ? codes.map(c => codeRow(c, csrf)).join('')
            : `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:32px">No codes found</td></tr>`}
        </tbody>
      </table>
    </div>
    <div class="pagination">
      ${page > 1 ? `<a href="/admin/codes?page=${page-1}${qs}">← Prev</a>` : '<span>← Prev</span>'}
      <span>Page <strong>${page}</strong> of <strong>${totalPages}</strong></span>
      ${page < totalPages ? `<a href="/admin/codes?page=${page+1}${qs}">Next →</a>` : '<span>Next →</span>'}
      <span style="margin-left:8px">${total} codes ${statusFilter ? '(filtered)' : 'total'}</span>
    </div>
  </div>
</div>

<script>
// ── Bulk form safeguards ──────────────────────────────────────
const WARN_AT  = ${BULK_WARN_AT};
const bulkForm = document.getElementById('bulkForm');
const bulkCount = document.getElementById('bulkCount');
const bulkHint  = document.getElementById('bulkHint');

bulkCount.addEventListener('input', function() {
  const n = parseInt(this.value) || 0;
  if (n >= WARN_AT) {
    bulkHint.textContent = '⚠ Generating ' + n + ' codes — this may take a few seconds.';
    bulkHint.style.color = 'var(--warn)';
  } else {
    bulkHint.textContent = '';
  }
});

bulkForm.addEventListener('submit', function(e) {
  const n = parseInt(bulkCount.value) || 0;
  if (n >= WARN_AT) {
    const ok = confirm(
      'You are about to generate ' + n + ' invitation codes.\\n\\n' +
      'This will create ' + n + ' new KV entries.\\n\\n' +
      'Continue?'
    );
    if (!ok) e.preventDefault();
  }
});
</script>`;

  return adminShell(session, 'codes', content, extraHead);
}

function codeRow(c, csrf) {
  return `<tr>
    <td><code>${e(c.key)}</code></td>
    <td>${statusBadge(c)}</td>
    <td>${c.current_uses} / ${c.max_uses}</td>
    <td style="font-size:12px;color:var(--muted);white-space:nowrap">${formatDate(c.expiration_date)}</td>
    <td style="font-size:12px;color:var(--muted);white-space:nowrap">${formatDate(c.created_at)}</td>
    <td>
      <div class="action-row">
        <form method="POST" action="/admin/codes/toggle" style="margin:0">
          <input type="hidden" name="_csrf" value="${e(csrf)}">
          <input type="hidden" name="code" value="${e(c.key)}">
          <button class="btn btn-secondary btn-sm" type="submit">${c.enabled ? '🔕' : '✔️'}</button>
        </form>
        <form method="POST" action="/admin/codes/delete" style="margin:0"
          onsubmit="return confirm('Delete code ${e(c.key)}? Cannot be undone.')">
          <input type="hidden" name="_csrf" value="${e(csrf)}">
          <input type="hidden" name="code" value="${e(c.key)}">
          <button class="btn btn-danger btn-sm" type="submit">🗑️</button>
        </form>
      </div>
    </td>
  </tr>`;
}

// ─────────────────────────────────────────────────────────────
// LOGS PAGE
// ─────────────────────────────────────────────────────────────
function logsPageHTML(session, logs, page, totalPages, filter, total) {
  const actions = ['redeem_ok','redeem_fail','redeem_rate_limited','admin_login_ok','admin_login_fail',
                   'admin_create_code','admin_bulk_create','admin_delete_code','admin_enable_code','admin_disable_code'];
  const qs = filter ? `&action=${enc(filter)}` : '';

  const content = `
<div class="topbar">
  <span class="topbar-title">Activity Logs <span style="color:var(--muted);font-size:13px;font-weight:400">(${total} entries)</span></span>
</div>
<div class="content">
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;flex-wrap:wrap;gap:10px">
      <div class="card-title" style="margin-bottom:0">Log Viewer</div>
      <form method="GET" action="/admin/logs" style="display:flex;gap:8px;align-items:center">
        <select name="action" style="width:210px">
          <option value="">All actions</option>
          ${actions.map(a=>`<option value="${a}" ${filter===a?'selected':''}>${a}</option>`).join('')}
        </select>
        <button class="btn btn-secondary btn-sm" type="submit">Filter</button>
        ${filter ? `<a href="/admin/logs" class="btn btn-secondary btn-sm">Clear</a>` : ''}
      </form>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Timestamp</th><th>Action</th><th>Email</th><th>Code</th><th>IP</th><th>Details</th>
        </tr></thead>
        <tbody>
          ${logs.length
            ? logs.map(logRow).join('')
            : `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:32px">No log entries</td></tr>`}
        </tbody>
      </table>
    </div>
    <div class="pagination">
      ${page > 1 ? `<a href="/admin/logs?page=${page-1}${qs}">← Prev</a>` : ''}
      <span>Page <strong>${page}</strong> of <strong>${totalPages}</strong></span>
      ${page < totalPages ? `<a href="/admin/logs?page=${page+1}${qs}">Next →</a>` : ''}
    </div>
  </div>
</div>`;
  return adminShell(session, 'logs', content);
}

function logRow(log) {
  if (!log) return '';
  const detail = log.reason ? `reason: ${e(log.reason)}`
    : log.count ? `count: ${log.count}`
    : log.by    ? `by: ${e(log.by)}`
    : log.batch_id ? `batch: ${e(log.batch_id)}` : '';
  return `<tr>
    <td style="font-size:11px;color:var(--muted);white-space:nowrap">${e(log.timestamp??'')}</td>
    <td>${actionLabel(log.action??'')}</td>
    <td style="font-size:12px">${e(log.email??'—')}</td>
    <td><code>${e(log.code??'—')}</code></td>
    <td style="font-size:11px;color:var(--muted)">${e(log.ip??'—')}</td>
    <td style="font-size:12px;color:var(--muted)">${detail}</td>
  </tr>`;
}

// ─────────────────────────────────────────────────────────────
// ERROR PAGES
// ─────────────────────────────────────────────────────────────
function page404() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>404</title></head>
<body style="font-family:sans-serif;text-align:center;padding:60px">
  <h1 style="font-size:64px;margin-bottom:12px">404</h1>
  <p style="color:#888">Page not found.</p><br><a href="/">← Home</a>
</body></html>`;
}
function page403() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>403</title></head>
<body style="font-family:sans-serif;text-align:center;padding:60px">
  <h1 style="font-size:64px;margin-bottom:12px">403</h1>
  <p style="color:#888">Forbidden. Invalid CSRF token.</p>
</body></html>`;
}
function page500() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>500</title></head>
<body style="font-family:sans-serif;text-align:center;padding:60px">
  <h1 style="font-size:64px;margin-bottom:12px">500</h1>
  <p style="color:#888">Internal server error. Check Worker logs.</p>
</body></html>`;
}

// Flash message reader (reads ?success / ?error from URL)
function flashScript() {
  return `<script>
(function(){
  const p = new URLSearchParams(location.search);
  const s = p.get('success'), err = p.get('error');
  if (!s && !err) return;
  const div = document.createElement('div');
  div.className = 'alert ' + (s ? 'alert-success' : 'alert-error');
  div.textContent = s || err;
  const content = document.querySelector('.content');
  if (content) content.prepend(div);
  const keep = ['page','q','status','batch'];
  const np = new URLSearchParams();
  keep.forEach(k => { if (p.has(k)) np.set(k, p.get(k)); });
  const ns = np.toString();
  history.replaceState(null, '', location.pathname + (ns ? '?' + ns : ''));
})();
</script>`;
}
