/**
 * PhiMail Rung 2A: proof-of-concept Gmail read-only bridge.
 *
 * IMPORTANT: experimental single-process service, not production-hosted mail.
 * Gmail tokens and sessions are kept only in server RAM; never in browser storage.
 * In production the bridge must sit behind a same-origin HTTPS reverse proxy.
 */
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createPhiIdDevAdapter } from './phiid-dev.js';

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_URL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const OAUTH_LIFETIME_MS = 10 * 60 * 1000;
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

function encode64url(bytes) { return Buffer.from(bytes).toString('base64url'); }
function randomToken() { return encode64url(randomBytes(32)); }
function compareSecret(a, b) {
  const ab = Buffer.from(a || '');
  const bb = Buffer.from(b || '');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
function parseCookies(raw = '') {
  return Object.fromEntries(raw.split(';').map(item => {
    const index = item.indexOf('=');
    return index < 0 ? [] : [item.slice(0, index).trim(), item.slice(index + 1).trim()];
  }).filter(item => item.length === 2));
}
function json(res, status, value, extra = {}) {
  res.writeHead(status, { ...JSON_HEADERS, ...extra });
  res.end(JSON.stringify(value));
}
function redirect(res, location, cookies = []) {
  res.writeHead(302, { ...JSON_HEADERS, Location: location, 'Set-Cookie': cookies });
  res.end();
}
function headersOf(payload) {
  return Object.fromEntries((payload?.headers || []).filter(entry => typeof entry?.name === 'string').map(item => [item.name.toLowerCase(), String(item.value || '')]));
}
function readableBody(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (payload.mimeType === 'text/plain' && typeof payload.body?.data === 'string') {
    try { return Buffer.from(payload.body.data, 'base64url').toString('utf8').slice(0, 100000); }
    catch { return ''; }
  }
  for (const part of payload.parts || []) {
    const candidate = readableBody(part);
    if (candidate) return candidate;
  }
  return '';
}
function gmailSummary(record, email) {
  const headers = headersOf(record.payload);
  const sender = headers.from || '(Unknown sender)';
  const internalDate = Number(record.internalDate);
  const date = Number.isFinite(internalDate) && internalDate > 0 ? new Date(internalDate).toISOString() : new Date(0).toISOString();
  return {
    id: record.id,
    threadId: record.threadId || null,
    from: sender,
    email: sender,
    to: headers.to || email,
    subject: headers.subject || '(No subject)',
    date,
    preview: record.snippet || '',
    unread: Array.isArray(record.labelIds) && record.labelIds.includes('UNREAD'),
    starred: Array.isArray(record.labelIds) && record.labelIds.includes('STARRED'),
    labels: [],
    folder: 'inbox',
    provider: 'gmail'
  };
}

/**
 * Inject fetch for isolated OAuth/Gmail test doubles. No external requests in unit tests.
 */
export function createBridge({ env = process.env, fetchImpl = fetch } = {}) {
  const configuredOrigin = env.BRIDGE_PUBLIC_ORIGIN || 'http://localhost:5173';
  const frontendOrigin = new URL(configuredOrigin);
  if (frontendOrigin.pathname !== '/' || frontendOrigin.search || frontendOrigin.hash) throw new Error('BRIDGE_PUBLIC_ORIGIN must be an origin only');
  if (frontendOrigin.protocol !== 'https:' && !(frontendOrigin.protocol === 'http:' && ['localhost','127.0.0.1'].includes(frontendOrigin.hostname))) throw new Error('Bridge requires HTTPS except localhost');
  if (env.NODE_ENV === 'production' && env.PHIMAIL_ENABLE_EXPERIMENTAL_BRIDGE !== '1') throw new Error('Production deployment requires an explicit experimental bridge opt-in and security review');
  const origin = frontendOrigin.origin;
  const secure = frontendOrigin.protocol === 'https:';
  const callback = origin + '/auth/google/callback';
  if (env.GOOGLE_REDIRECT_URI && env.GOOGLE_REDIRECT_URI !== callback) throw new Error('GOOGLE_REDIRECT_URI must match the bridge callback on BRIDGE_PUBLIC_ORIGIN');
  const clientId = env.GOOGLE_CLIENT_ID || '';
  const clientSecret = env.GOOGLE_CLIENT_SECRET || '';
  const ready = Boolean(clientId && clientSecret);
  const phiidDev = createPhiIdDevAdapter({ env });
  const oauthPending = new Map();
  const sessions = new Map();
  const startLimits = new Map();

  function cookie(name, value, maxAge, path) {
    return name + '=' + value + '; Path=' + path + '; Max-Age=' + maxAge + '; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : '');
  }
  function cleanExpired() {
    const now = Date.now();
    for (const [key, entry] of oauthPending) if (entry.expires < now) oauthPending.delete(key);
    for (const [key, entry] of sessions) if (entry.expires < now) sessions.delete(key);
    for (const [key, entry] of startLimits) if (entry.until < now) startLimits.delete(key);
  }
  function validateOrigin(req) {
    return req.headers.origin === origin;
  }
  function sessionFor(req) {
    const sid = parseCookies(req.headers.cookie).pm_session;
    return sid ? sessions.get(sid) : undefined;
  }
  async function requestProvider(url, options = {}) {
    const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(12000) });
    if (!response.ok) {
      const error = new Error(response.status === 429 ? 'Provider rate limit reached' : 'Provider request failed');
      error.status = response.status === 429 ? 429 : 502;
      throw error;
    }
    return response.json();
  }
  async function accessToken(session) {
    if (session.accessExpires > Date.now() + 30_000) return session.accessToken;
    if (!session.refreshToken) {
      const error = new Error('Gmail session expired, please reconnect');
      error.status = 401;
      throw error;
    }
    const data = await requestProvider(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: session.refreshToken, grant_type: 'refresh_token' })
    });
    if (!data.access_token) throw new Error('Provider did not return a valid access token');
    session.accessToken = data.access_token;
    session.accessExpires = Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000;
    return session.accessToken;
  }
  async function gmailGet(session, path) {
    const token = await accessToken(session);
    return requestProvider(GMAIL_URL + path, { headers: { Authorization: 'Bearer ' + token } });
  }
  async function handle(req, res) {
    cleanExpired();
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Cache-Control','no-store');
    const url = new URL(req.url || '/', origin);
    const path = url.pathname;
    // Independent OIDC test client: no Gmail session/token is shared.
    if (await phiidDev.handle(req, res, url)) return;
    if (req.method === 'GET' && path === '/api/health') return json(res, 200, { service: 'phimail-bridge', mode: 'experimental', status: 'up' });
    if (req.method === 'GET' && path === '/api/providers') return json(res, 200, {
      mode: 'experimental-readonly', sameOriginRequired: true,
      providers: [{ id: 'gmail', ready, capabilities: ['read:inbox', 'read:message'] },
        { id: 'outlook', ready: false, capabilities: [] }, { id: 'imap', ready: false, capabilities: [] }]
    });

    if (req.method === 'GET' && path === '/auth/google/start') {
      if (!ready) return json(res, 503, { error: 'Gmail OAuth is not configured on the bridge.' });
      const ip = req.socket.remoteAddress || '';
      const limit = startLimits.get(ip) || { count: 0, until: Date.now() + 600_000 };
      if (++limit.count > 8) return json(res, 429, { error: 'Too many OAuth attempts. Please retry later.' });
      startLimits.set(ip, limit);
      const pendingId = randomToken(), state = randomToken(), verifier = randomToken();
      oauthPending.set(pendingId, { state, verifier, expires: Date.now() + OAUTH_LIFETIME_MS });
      const auth = new URL(AUTH_URL);
      for (const [key, value] of Object.entries({
        client_id: clientId, redirect_uri: callback, response_type: 'code',
        scope: SCOPE, state, code_challenge: encode64url(createHash('sha256').update(verifier).digest()),
        code_challenge_method: 'S256', access_type: 'offline'
      })) auth.searchParams.set(key, value);
      return redirect(res, auth.toString(), [cookie('pm_oauth', pendingId, 600, '/auth/google')]);
    }

    if (req.method === 'GET' && path === '/auth/google/callback') {
      const pendingId = parseCookies(req.headers.cookie).pm_oauth;
      const pending = pendingId ? oauthPending.get(pendingId) : undefined;
      if (pendingId) oauthPending.delete(pendingId);
      const cleared = cookie('pm_oauth', '', 0, '/auth/google');
      if (!pending || pending.expires < Date.now() || !compareSecret(pending.state, url.searchParams.get('state')))
        return json(res, 400, { error: 'Invalid or expired OAuth state' }, { 'Set-Cookie': cleared });
      if (url.searchParams.has('error')) return redirect(res, origin + '/?phimail=denied', [cleared]);
      const code = url.searchParams.get('code');
      if (!code || code.length > 4096) return json(res, 400, { error: 'Missing or invalid authorization code' }, { 'Set-Cookie': cleared });
      const token = await requestProvider(TOKEN_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: clientId, client_secret: clientSecret, redirect_uri: callback,
          code_verifier: pending.verifier, grant_type: 'authorization_code'
        })
      });
      if (!token.access_token || !token.expires_in) return json(res, 502, { error: 'Provider did not supply a usable access token' }, { 'Set-Cookie': cleared });
      const profile = await requestProvider(GMAIL_URL + '/profile', { headers: { Authorization: 'Bearer ' + token.access_token } });
      if (typeof profile.emailAddress !== 'string' || !profile.emailAddress.includes('@'))
        return json(res, 502, { error: 'Provider did not return an email identity' }, { 'Set-Cookie': cleared });
      const oldSid = parseCookies(req.headers.cookie).pm_session;
      if (oldSid) sessions.delete(oldSid);
      const sid = randomToken();
      sessions.set(sid, { email: profile.emailAddress, accessToken: token.access_token, refreshToken: token.refresh_token || null,
        accessExpires: Date.now() + Number(token.expires_in) * 1000, expires: Date.now() + SESSION_LIFETIME_MS });
      return redirect(res, origin + '/?phimail=connected', [cleared, cookie('pm_session', sid, 8*60*60, '/api')]);
    }

    if (req.method === 'GET' && path === '/api/session') {
      const session = sessionFor(req);
      return json(res, 200, { connected: Boolean(session), provider: session ? 'gmail' : null, email: session?.email || null, capabilities: session ? ['read:inbox', 'read:message'] : [] });
    }

    if (req.method === 'POST' && path === '/api/session/disconnect') {
      if (!validateOrigin(req)) return json(res, 403, { error: 'Origin mismatch' });
      const sid = parseCookies(req.headers.cookie).pm_session;
      if (sid) sessions.delete(sid);
      return json(res, 200, { connected: false }, { 'Set-Cookie': cookie('pm_session', '', 0, '/api') });
    }

    if (req.method === 'GET' && (path === '/api/mail/messages' || path.startsWith('/api/mail/messages/'))) {
      const session = sessionFor(req);
      if (!session) return json(res, 401, { error: 'Connect an account first' });
      if (path === '/api/mail/messages') {
        const requested = Number(url.searchParams.get('limit') || 15);
        const limit = Number.isInteger(requested) ? Math.max(1, Math.min(requested, 20)) : 15;
        const list = await gmailGet(session, '/messages?labelIds=INBOX&maxResults=' + limit);
        const ids = Array.isArray(list.messages) ? list.messages.slice(0,limit) : [];
        const summaries = await Promise.all(ids.map(item => gmailGet(session,'/messages/'+encodeURIComponent(item.id)+'?format=metadata')));
        return json(res, 200, { messages: summaries.map(record => gmailSummary(record,session.email)), nextPageAvailable: Boolean(list.nextPageToken) });
      }
      const id = path.slice('/api/mail/messages/'.length);
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return json(res, 400, { error: 'Invalid message identifier' });
      const record = await gmailGet(session, '/messages/' + encodeURIComponent(id) + '?format=full');
      const message = gmailSummary(record,session.email);
      return json(res, 200, { ...message, body: readableBody(record.payload) || '[No plain-text body found. HTML is deliberately not rendered in this pilot.]' });
    }
    return json(res, 404, { error: 'Not found' });
  }
  return createServer((req, res) => {
    Promise.resolve(handle(req, res)).catch(error => {
      if (res.headersSent) return res.end();
      const status = error.status || 500;
      json(res, status, { error: status === 500 ? 'Unexpected bridge error' : (error.message || 'Provider request failed') });
    });
  });
}
