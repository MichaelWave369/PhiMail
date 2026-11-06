/**
 * PhiMail R2B: independent, LOCAL-only OIDC relying-party integration.
 *
 * This is separate from Gmail OAuth: a PhiID sign-in NEVER connects or grants
 * mailbox access. The browser receives only a minimal validated profile;
 * signed tokens are processed by the vetted OIDC library then discarded.
 */
import * as oidc from 'openid-client';
import { randomBytes } from 'node:crypto';

const ISSUER = 'http://127.0.0.1:8080/realms/phiid-dev';
const CLIENT_ID = 'phimail-phiid-dev';
const ORIGIN = 'http://localhost:5173';
const REDIRECT_URI = ORIGIN + '/auth/phiid/callback';
const AUTH_PREFIX = '/auth/phiid';
const SESSION_PREFIX = '/api/phiid';
const FLOW_TTL = 5 * 60_000;
const SESSION_TTL = 15 * 60_000;
const MAX_PENDING = 128;
const MAX_SESSIONS = 256;

function randomId() { return randomBytes(32).toString('base64url'); }
function selectCookie(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  const matched = cookies
    .map(x => x.trim()).filter(x => x.startsWith(name + '='))
    .map(x => x.slice(name.length + 1));
  if (matched.length !== 1 || !/^[\w-]{20,100}$/.test(matched[0])) return null;
  return matched[0];
}
function cookie(name, value, ttl, path) {
  return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${ttl}`;
}
function json(res, status, value, extra = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer',
    'X-Frame-Options':'DENY',
    'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",
    ...extra,
  });
  res.end(body);
}
function redirect(res, url, cookies = []) {
  res.writeHead(302, {
    Location:url, 'Set-Cookie': cookies,
    'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer',
    'X-Content-Type-Options':'nosniff',
  });
  res.end();
}
function prune(map, now = Date.now()) {
  for (const [id, value] of map) if (!value || value.expires <= now) map.delete(id);
}

export function assertPhiIdProviderMetadata(meta) {
  if (!meta || meta.issuer !== ISSUER) throw new Error('unexpected_oidc_issuer');
  const endpoints = {
    authorization_endpoint: ISSUER + '/protocol/openid-connect/auth',
    token_endpoint: ISSUER + '/protocol/openid-connect/token',
    jwks_uri: ISSUER + '/protocol/openid-connect/certs',
  };
  for (const [key, expected] of Object.entries(endpoints)) {
    if (meta[key] !== expected) throw new Error('unexpected_oidc_provider_endpoint');
  }
  return true;
}

export function assertPhiIdLocalRequest(req) {
  return req.headers.host === 'localhost:5173' &&
    ['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) &&
    req.headers['sec-fetch-site'] !== 'cross-site';
}

export function createPhiIdDevAdapter({ env = process.env, oidcClient = oidc } = {}) {
  const enabled = env.PHIMAIL_ENABLE_PHIID_DEV === '1';
  if (enabled && env.NODE_ENV === 'production') {
    throw new Error('PhiID development bridge must never run in production');
  }
  const pending = new Map();
  const sessions = new Map();
  let configPromise;

  function config() {
    if (!configPromise) configPromise = oidcClient.discovery(
      new URL(ISSUER), CLIENT_ID,
      { token_endpoint_auth_method:'none' }, oidcClient.None(),
      { execute:[oidcClient.allowInsecureRequests], timeout: 8 },
    ).then(c => {
      assertPhiIdProviderMetadata(c.serverMetadata());
      if (!c.serverMetadata().supportsPKCE()) throw new Error('S256_pkce_required');
      return c;
    }).catch(e => { configPromise = undefined; throw e; });
    return configPromise;
  }

  async function handle(req, res, url) {
    const path = url.pathname;
    if (![AUTH_PREFIX, SESSION_PREFIX].some(prefix => path === prefix || path.startsWith(prefix + '/'))) {
      return false;
    }
    if (!assertPhiIdLocalRequest(req)) {
      json(res, 403, { error:'loopback_proxy_only' });
      return true;
    }
    if (!enabled) {
      if (req.method === 'GET' && path === '/api/phiid/session') {
        json(res, 200, { enabled:false, authenticated:false, environment:'dev_only' });
      } else json(res, 404, { error:'phiid_dev_bridge_disabled' });
      return true;
    }
    prune(pending);
    prune(sessions);
    const sid = selectCookie(req, 'pm_phi_id');
    const current = sid ? sessions.get(sid) : undefined;
    if (req.method === 'GET' && req.url === '/api/phiid/session') {
      json(res, 200, current ? {
        enabled:true, authenticated:true, environment:'dev_only',
        issuer: ISSUER, subject:current.subject, display_name:current.display_name,
        capabilities:[], mailbox_connected:false, phios_authority:false,
      } : { enabled:true, authenticated:false, environment:'dev_only',
        capabilities:[], mailbox_connected:false, phios_authority:false });
      return true;
    }
    if (req.method === 'GET' && req.url === '/auth/phiid/start') {
      if (pending.size >= MAX_PENDING) {
        json(res, 429, { error:'too_many_pending_signins' });
        return true;
      }
      const configuration = await config();
      const flowId=randomId();
      const verifier=oidcClient.randomPKCECodeVerifier();
      const challenge=await oidcClient.calculatePKCECodeChallenge(verifier);
      const state=oidcClient.randomState();
      const nonce=oidcClient.randomNonce();
      pending.set(flowId, { verifier,state,nonce,expires:Date.now()+FLOW_TTL });
      const destination=oidcClient.buildAuthorizationUrl(configuration,{
        redirect_uri:REDIRECT_URI,scope:'openid profile',
        code_challenge:challenge,code_challenge_method:'S256',state,nonce,
      });
      redirect(res,destination.href,[cookie('pm_phi_flow',flowId,300,AUTH_PREFIX)]);
      return true;
    }
    if (req.method === 'GET' && path === '/auth/phiid/callback') {
      const id=selectCookie(req,'pm_phi_flow');
      const flow=id?pending.get(id):undefined;
      if(id)pending.delete(id);
      const clearFlow=cookie('pm_phi_flow','',0,AUTH_PREFIX);
      if(!flow || flow.expires <= Date.now()) {
        json(res,400,{error:'missing_or_expired_oidc_flow'},{'Set-Cookie':clearFlow});
        return true;
      }
      if (url.searchParams.getAll('state').length !== 1 ||
          url.searchParams.getAll('code').length !== 1 ||
          url.searchParams.get('state') !== flow.state ||
          !url.searchParams.get('code')) {
        json(res,400,{error:'invalid_oidc_callback'},{'Set-Cookie':clearFlow});
        return true;
      }
      const configuration=await config();
      const tokens=await oidcClient.authorizationCodeGrant(configuration,url,{
        pkceCodeVerifier:flow.verifier,
        expectedState:flow.state,
        expectedNonce:flow.nonce,
        idTokenExpected:true,
      });
      const claims=tokens.claims();
      if(!claims || claims.iss!==ISSUER || typeof claims.sub!=='string' ||
         !claims.sub || claims.sub.length>255 || typeof claims.exp!=='number') {
        json(res,401,{error:'verified_identity_unavailable'},{'Set-Cookie':clearFlow});
        return true;
      }
      const remaining=Math.min(SESSION_TTL,claims.exp*1000-Date.now());
      if(remaining <= 0 || sessions.size >= MAX_SESSIONS) {
        json(res,401,{error:'identity_session_unavailable'},{'Set-Cookie':clearFlow});
        return true;
      }
      const old=selectCookie(req,'pm_phi_id');
      if(old)sessions.delete(old);
      const newId=randomId();
      sessions.set(newId,{
        subject:claims.sub,
        display_name:typeof claims.preferred_username==='string'?claims.preferred_username.slice(0,64):null,
        expires:Date.now()+remaining,
      });
      // ID/access/refresh tokens are never persisted, forwarded or put into JS.
      redirect(res,ORIGIN+'/?phiid=verified',[clearFlow,
        cookie('pm_phi_id',newId,Math.max(1,Math.floor(remaining/1000)),SESSION_PREFIX)]);
      return true;
    }
    if (req.method === 'POST' && req.url === '/api/phiid/logout') {
      if(req.headers.origin!==ORIGIN || req.headers['x-phimail-action']!=='phiid-logout' ||
         req.headers['sec-fetch-site']==='cross-site') {
        json(res,403,{error:'cross_origin_action_denied'});
        return true;
      }
      if(sid)sessions.delete(sid);
      json(res,200,{
        authenticated:false,
        note:'PhiMail local identity session ended; Keycloak SSO and Gmail sessions remain independent.',
      },{'Set-Cookie':cookie('pm_phi_id','',0,SESSION_PREFIX)});
      return true;
    }
    json(res,404,{error:'not_found'});
    return true;
  }

  return { handle, enabled };
}
