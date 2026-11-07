/**
 * PhiMail Rung 2A: proof-of-concept Gmail read-only bridge.
 *
 * IMPORTANT: experimental single-process service, not production-hosted mail.
 * Gmail tokens and sessions are kept only in server RAM; never in browser storage.
 * In production the bridge must sit behind a same-origin HTTPS reverse proxy.
 */
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createPhiIdLab } from './phiid-lab.js';
import { createMailboxReview } from './mailbox-review.js';
import { createMailboxGateway } from './mailbox-core.js';
import { createGmailReadAdapter } from './providers/gmail.js';
import { createOutlookReadAdapter } from './providers/outlook.js';
import { createMicrosoftLab } from './outlook-lab.js';
import { createImapReadAdapter } from './providers/imap.js';
import { createImapLab } from './imap-lab.js';

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const OAUTH_LIFETIME_MS = 10 * 60 * 1000;
const MAX_PROVIDER_BYTES = 1024 * 1024;
const MAX_SESSION_COUNT = 128;
const MAX_MAIL_CALLS_PER_MINUTE = 30;
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

function encode64url(bytes) { return Buffer.from(bytes).toString('base64url'); }
function randomToken() { return encode64url(randomBytes(32)); }
function compareSecret(a, b) {
  const ab = Buffer.from(a || '');
  const bb = Buffer.from(b || '');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
function parseCookies(raw = '') {
  // Duplicate cookie names can be sent when old and new Path attributes coexist.
  // Refuse ambiguous sessions rather than silently choosing an attacker's value.
  const result = Object.create(null), seen = new Set(), duplicates = new Set();
  for (const item of String(raw).slice(0, 8192).split(';')) {
    const index = item.indexOf('=');
    if (index < 0) continue;
    const name = item.slice(0,index).trim(), value = item.slice(index+1).trim();
    if (!['pm_session','pm_oauth','pm_google'].includes(name)) continue;
    if (seen.has(name)) { duplicates.add(name); continue; }
    seen.add(name);
    if (/^[A-Za-z0-9_-]{20,100}$/.test(value)) result[name] = value;
  }
  for (const name of duplicates) delete result[name];
  return result;
}
function json(res, status, value, extra = {}) {
  res.writeHead(status, { ...JSON_HEADERS, ...extra });
  res.end(JSON.stringify(value));
}
function redirect(res, location, cookies = []) {
  res.writeHead(302, { ...JSON_HEADERS, Location: location, 'Set-Cookie': cookies });
  res.end();
}
/**
 * Inject fetch for isolated OAuth/Gmail test doubles. No external requests in unit tests.
 */
export function createBridge({ env = process.env, fetchImpl = fetch, identityProvider = null, imapClientFactory = null } = {}) {
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
  const phiidLab = createPhiIdLab({env,provider:identityProvider});
  const oauthPending = new Map();
  const sessions = new Map();
  // Rotation handles are NOT Gmail session credentials and are scoped only
  // to the Google callback path; the bearer session stays scoped to /api.
  const rotations = new Map();
  const startLimits = new Map();

  function cookie(name, value, maxAge, path) {
    return name + '=' + value + '; Path=' + path + '; Max-Age=' + maxAge + '; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : '');
  }
  function cleanExpired() {
    const now = Date.now();
    for (const [key, entry] of oauthPending) if (entry.expires < now) oauthPending.delete(key);
    for (const [key, entry] of sessions) if (entry.expires < now) sessions.delete(key);
    for (const [handle, sid] of rotations) if (!sessions.has(sid)) rotations.delete(handle);
    for (const [key, entry] of startLimits) if (entry.until < now) startLimits.delete(key);
  }
  function validateOrigin(req) {
    return req.headers.origin === origin;
  }
  function sessionFor(req) {
    const sid = parseCookies(req.headers.cookie).pm_session;
    return sid ? sessions.get(sid) : undefined;
  }
  async function requestProvider(url, options = {}, maxBytes = MAX_PROVIDER_BYTES) {
    const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(12000) });
    if (!response.ok) {
      const error = new Error(response.status === 429 ? 'Provider rate limit reached' : 'Provider request failed');
      error.status = response.status === 429 ? 429 : 502;
      throw error;
    }
    const advertised = response.headers?.get?.('content-length');
    if (advertised && Number(advertised) > maxBytes) {
      throw Object.assign(new Error('Provider response exceeded size limit'), {status:502});
    }
    let size = 0;
    const parts = [];
    if (!response.body) throw Object.assign(new Error('Empty provider response'),{status:502});
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) throw Object.assign(new Error('Provider response exceeded size limit'),{status:502});
      parts.push(Buffer.from(chunk));
    }
    try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
    catch { throw Object.assign(new Error('Invalid provider JSON'),{status:502}); }
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
    }, 64_000);
    if (typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 8192) {
      throw Object.assign(new Error('Provider did not return a valid access token'),{status:502});
    }
    session.accessToken = data.access_token;
    session.accessExpires = Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000;
    return session.accessToken;
  }
  async function runLimitedMail(session, res, operation) {
    const now = Date.now();
    if (!session.mailBudget || now - session.mailBudget.started >= 60_000) {
      session.mailBudget = {started:now,count:0,active:0};
    }
    const budget = session.mailBudget;
    if (budget.count >= MAX_MAIL_CALLS_PER_MINUTE || budget.active >= 2) {
      json(res,429,{error:'Local mailbox request limit reached. Retry shortly.'});
      return;
    }
    budget.count += 1;
    budget.active += 1;
    try { await operation(); }
    finally { budget.active -= 1; }
  }
  const gmailAdapter=createGmailReadAdapter({
    requestProvider,accessToken,ready
  });
  // Each OAuth provider owns its own cookie and server-only session store.
  // Outlook's resource grant cannot authorize Gmail or the PhiID lab.
  const outlookAdapter=createOutlookReadAdapter({
    requestProvider,
    accessToken: session=>microsoftLab.accessToken(session),
    ready: Boolean(env.MICROSOFT_CLIENT_ID&&env.MICROSOFT_CLIENT_SECRET) &&
      env.BRIDGE_PUBLIC_ORIGIN==='http://127.0.0.1:5173' &&
      env.NODE_ENV!=='production',
  });
  const microsoftLab=createMicrosoftLab({
    env,requestProvider,profile:token=>outlookAdapter.profile(token)
  });
  const imapAdapter=createImapReadAdapter({
    env,...(imapClientFactory?{clientFactory:imapClientFactory}:{})
  });
  const imapLab=createImapLab({env,adapter:imapAdapter});
  const mailboxes=createMailboxGateway({adapters:[
    gmailAdapter,
    createOutlookReadAdapter({
      requestProvider,accessToken:session=>microsoftLab.accessToken(session),
      ready:microsoftLab.configured
    }),
    imapAdapter
  ]});
  const mailboxReview=createMailboxReview({env,identityLab:phiidLab,gmailSessionFor:sessionFor});
  function providerName(url){
    const requested=url.searchParams.getAll('provider');
    if(requested.length>1|| !['gmail','outlook','imap'].includes(requested[0]||'gmail')){
      return null;
    }
    return requested[0]||'gmail';
  }
  function providerSession(req,provider){
    return provider==='outlook'?microsoftLab.sessionFor(req):provider==='imap'?imapLab.sessionFor(req):sessionFor(req);
  }

  async function handle(req, res) {
    cleanExpired();
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Cache-Control','no-store');
    const url = new URL(req.url || '/', origin);
    const path = url.pathname;
    // Review runs first because the PhiID lab reserves /api/identity/*.
    if (await mailboxReview.handle(req,res,path,url)) return;
    if (await microsoftLab.handle(req,res,path,url)) return;
    if (await imapLab.handle(req,res,path,url)) return;
    if (await phiidLab.handle(req,res,path,url)) return;
    if (req.method === 'GET' && path === '/api/health') return json(res, 200, { service: 'phimail-bridge', mode: 'experimental', status: 'up' });
    if (req.method === 'GET' && path === '/api/providers') return json(res, 200, {
      mode: 'experimental-readonly', sameOriginRequired: true,
      providers: mailboxes.catalog()
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
      if (String(req.url || '').length > 8192) return json(res,400,{error:'Invalid OAuth callback'});
      const pendingId = parseCookies(req.headers.cookie).pm_oauth;
      const pending = pendingId ? oauthPending.get(pendingId) : undefined;
      if (pendingId) oauthPending.delete(pendingId);
      const cleared = cookie('pm_oauth', '', 0, '/auth/google');
      if (!pending || pending.expires < Date.now() ||
          url.searchParams.getAll('state').length !== 1 ||
          !compareSecret(pending.state, url.searchParams.get('state')))
        return json(res, 400, { error: 'Invalid or expired OAuth state' }, { 'Set-Cookie': cleared });
      if (url.searchParams.has('error')) return redirect(res, origin + '/?phimail=denied', [cleared]);
      const code = url.searchParams.get('code');
      if (!code || code.length > 4096 || url.searchParams.getAll('code').length !== 1)
        return json(res, 400, { error: 'Missing or invalid authorization code' }, { 'Set-Cookie': cleared });
      const token = await requestProvider(TOKEN_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: clientId, client_secret: clientSecret, redirect_uri: callback,
          code_verifier: pending.verifier, grant_type: 'authorization_code'
        })
      }, 64_000);
      if (typeof token.access_token !== 'string' || !token.access_token || token.access_token.length > 8192 ||
          !Number.isFinite(Number(token.expires_in)) || Number(token.expires_in) <= 0 ||
          (token.refresh_token && (typeof token.refresh_token !== 'string' || token.refresh_token.length > 8192))) {
        return json(res,502,{error:'Provider did not supply usable OAuth tokens'},{'Set-Cookie':cleared});
      }
      const profile = await gmailAdapter.profile(token.access_token);
      if (typeof profile.emailAddress !== 'string' || !profile.emailAddress.includes('@'))
        return json(res, 502, { error: 'Provider did not return an email identity' }, { 'Set-Cookie': cleared });
      const previousHandle = parseCookies(req.headers.cookie).pm_google;
      const oldSid = previousHandle ? rotations.get(previousHandle) : undefined;
      if (previousHandle) rotations.delete(previousHandle);
      if (oldSid) {
        const previousSession = sessions.get(oldSid);
        if (previousSession?.rotation === previousHandle) sessions.delete(oldSid);
      }
      if (sessions.size >= MAX_SESSION_COUNT) {
        return json(res,429,{error:'Too many experimental sessions. Restart the local bridge.'},{'Set-Cookie':cleared});
      }
      const sid = randomToken(), rotation = randomToken();
      sessions.set(sid, { provider:'gmail', email: profile.emailAddress, sessionMarker: randomToken(), rotation, accessToken: token.access_token, refreshToken: token.refresh_token || null,
        accessExpires: Date.now() + Number(token.expires_in) * 1000, expires: Date.now() + SESSION_LIFETIME_MS });
      rotations.set(rotation,sid);
      // Important: cookies are scoped by host, not port. Never put the Gmail
      // bearer cookie at / on 127.0.0.1: it would reach local Keycloak too.
      return redirect(res, origin + '/?phimail=connected', [
        cleared, cookie('pm_session','',0,'/'), cookie('pm_session', sid, 8*60*60, '/api'),
        cookie('pm_google', rotation, 8*60*60, '/auth/google')
      ]);
    }

    if (req.method === 'GET' && path === '/api/session') {
      const provider=providerName(url);
      if(!provider)return json(res,400,{error:'invalid_provider_selection'});
      const session=providerSession(req,provider);
      return json(res, 200, {
        connected:Boolean(session),provider:session?.provider||null,
        email:session?.email||null,
        capabilities:session?['read:inbox','read:message']:[],
      });
    }

    if (req.method === 'POST' && path === '/api/session/disconnect') {
      const provider=providerName(url);
      if(!provider)return json(res,400,{error:'invalid_provider_selection'});
      if(provider==='outlook')return microsoftLab.logout(req,res);
      if(provider==='imap')return imapLab.logout(req,res);
      if (!validateOrigin(req)) return json(res, 403, { error: 'Origin mismatch' });
      const sid = parseCookies(req.headers.cookie).pm_session;
      if (sid) {
        const existing = sessions.get(sid);
        if (existing?.rotation) rotations.delete(existing.rotation);
        sessions.delete(sid);
      }
      return json(res, 200, { connected: false }, {
        'Set-Cookie': [
          cookie('pm_session','',0,'/api'),cookie('pm_session','',0,'/'),
          cookie('pm_google','',0,'/auth/google')
        ]
      });
    }

    if (req.method === 'GET' && (path === '/api/mail/messages' || path.startsWith('/api/mail/messages/'))) {
      const provider=providerName(url);
      if(!provider)return json(res,400,{error:'invalid_provider_selection'});
      const session=providerSession(req,provider);
      if (!session) return json(res, 401, { error: 'Connect an account first' });
      return runLimitedMail(session,res,async()=>{
        if (path === '/api/mail/messages') {
          const requested=Number(url.searchParams.get('limit') || 15);
          const limit=Number.isInteger(requested)?Math.max(1,Math.min(requested,20)):15;
          return json(res,200,await mailboxes.listInbox({session,limit}));
        }
        const id=path.slice('/api/mail/messages/'.length);
        return json(res,200,await mailboxes.readMessage({session,id}));
      });
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
