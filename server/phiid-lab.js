/**
 * PhiMail R2: LOCAL-ONLY independent OIDC relying-party session.
 * Uses the same Keycloak development realm as PhiID. Never consumes PhiID
 * cookies, JSON exports, or unverified browser claims as authentication.
 *
 * This is an experimental process-memory identity session, NOT hosted SSO,
 * mailbox authorization, PhiOS local-effect permission, or cloud access.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as oidc from 'openid-client';

export const DEV_ISSUER = 'http://127.0.0.1:8080/realms/phiid-dev';
export const DEV_CLIENT_ID = 'phimail-bff-dev';
export const DEV_ORIGIN = 'http://127.0.0.1:5173';
const FLOW_TTL = 5 * 60 * 1000;
const SESSION_TTL = 15 * 60 * 1000;
const MAX_PENDING = 128;
const MAX_SESSIONS = 512;

function randomId() { return randomBytes(32).toString('base64url'); }
function secureCompare(a, b) {
  const aa = Buffer.from(typeof a === 'string' ? a : '');
  const bb = Buffer.from(typeof b === 'string' ? b : '');
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function cookies(req) {
  const result = new Map();
  for (const pair of String(req.headers.cookie || '').split(';')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    const key = pair.slice(0, i).trim(), value = pair.slice(i+1).trim();
    if (!['pm_oidc_flow','pm_identity'].includes(key) || !/^[A-Za-z0-9_-]{20,100}$/.test(value) || result.has(key)) continue;
    result.set(key, value);
  }
  return result;
}
function cookie(name, value, age, path) {
  return name+'='+value+'; Path='+path+'; Max-Age='+age+'; HttpOnly; SameSite=Lax';
}
function json(res, status, data, cookies = []) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...(cookies.length ? {'Set-Cookie': cookies} : {}),
  });
  res.end(JSON.stringify(data));
}
function redirect(res, location, cookies = []) {
  res.writeHead(302, {
    Location: location,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...(cookies.length ? {'Set-Cookie': cookies} : {}),
  });
  res.end();
}
function providerMetadataIsPinned(metadata) {
  if (!metadata || metadata.issuer !== DEV_ISSUER) throw new TypeError('identity_provider_issuer_mismatch');
  const expected = {
    authorization_endpoint: '/realms/phiid-dev/protocol/openid-connect/auth',
    token_endpoint: '/realms/phiid-dev/protocol/openid-connect/token',
    jwks_uri: '/realms/phiid-dev/protocol/openid-connect/certs',
  };
  for (const [name, path] of Object.entries(expected)) {
    if (typeof metadata[name] !== 'string') throw new TypeError('missing_identity_endpoint');
    const url = new URL(metadata[name]);
    if (url.origin !== 'http://127.0.0.1:8080' || url.pathname !== path ||
        url.search || url.hash || url.username || url.password) {
      throw new TypeError('identity_endpoint_not_pinned_to_loopback');
    }
  }
  return true;
}
export function validatedLocalProfile(claims, now = Date.now()) {
  if (!claims || claims.iss !== DEV_ISSUER ||
      (claims.aud !== DEV_CLIENT_ID && !(Array.isArray(claims.aud) && claims.aud.includes(DEV_CLIENT_ID))) ||
      typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 ||
      typeof claims.exp !== 'number' || claims.exp * 1000 <= now) {
    throw new TypeError('missing_or_invalid_verified_oidc_claims');
  }
  return Object.freeze({
    authenticated: true,
    issuer: DEV_ISSUER,
    sub: claims.sub,
    preferred_username: typeof claims.preferred_username === 'string' ? claims.preferred_username.slice(0,64) : null,
    environment: 'local_development_only',
    grants: Object.freeze([]),
    mailbox_linked: false,
    cloud_authorized: false,
  });
}

function realProvider() {
  let configPromise;
  async function config() {
    if (!configPromise) {
      configPromise = oidc.discovery(new URL(DEV_ISSUER), DEV_CLIENT_ID,
        { token_endpoint_auth_method: 'none' }, oidc.None(),
        { execute: [oidc.allowInsecureRequests], timeout: 8 })
        .then(found => {
          providerMetadataIsPinned(found.serverMetadata());
          if (!found.serverMetadata().supportsPKCE()) throw new Error('s256_pkce_required');
          return found;
        })
        .catch(error => { configPromise = undefined; throw error; });
    }
    return configPromise;
  }
  return {
    async authorization(flow) {
      const c = await config();
      const challenge = await oidc.calculatePKCECodeChallenge(flow.verifier);
      return oidc.buildAuthorizationUrl(c, {
        redirect_uri: DEV_ORIGIN+'/auth/phiid/callback', scope: 'openid profile',
        code_challenge: challenge, code_challenge_method:'S256',
        state: flow.state, nonce: flow.nonce,
      }).href;
    },
    async exchange(url,flow) {
      const c = await config();
      const tokens = await oidc.authorizationCodeGrant(c, url, {
        pkceCodeVerifier: flow.verifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      });
      // Tokens intentionally discarded. No access to PhiCloud or mailbox.
      return tokens.claims();
    }
  };
}

/**
 * provider injection is ONLY used by isolated tests. Real runtime always
 * uses openid-client to verify tokens. No mock/auth header mode exists.
 */
export function createPhiIdLab({env = process.env, provider = null} = {}) {
  const enabled = env.PHIMAIL_LOCAL_PHIID === '1' &&
    env.BRIDGE_PUBLIC_ORIGIN === DEV_ORIGIN &&
    env.NODE_ENV !== 'production';
  const pending = new Map(), sessions = new Map();
  const identityProvider = provider || realProvider();
  function prune() {
    const now = Date.now();
    for (const [id,item] of pending) if (item.exp <= now) pending.delete(id);
    for (const [id,item] of sessions) if (item.exp <= now) sessions.delete(id);
  }
  function requestIsLocal(req) {
    const peer = req.socket?.remoteAddress;
    return req.headers.host === '127.0.0.1:5173' &&
      (peer === '127.0.0.1' || peer === '::ffff:127.0.0.1');
  }
  function activeSession(req) {
    const sid=cookies(req).get('pm_identity');
    return sid ? sessions.get(sid) : null;
  }
  async function handle(req,res,path,url) {
    if (!path.startsWith('/api/identity/') && !path.startsWith('/auth/phiid/')) return false;
    prune();
    if (!enabled) {
      return json(res, 503, {enabled:false,authenticated:false,error:'phiid_local_lab_disabled'}), true;
    }
    if (!requestIsLocal(req)) return json(res, 403, {error:'loopback_host_required'}), true;

    if (req.method === 'GET' && path === '/api/identity/session' && !url.search) {
      const session=activeSession(req);
      return json(res, 200, session ? {enabled:true,...session.profile} :
        {enabled:true,authenticated:false,environment:'local_development_only'}), true;
    }

    if (req.method === 'GET' && path === '/auth/phiid/start' && !url.search) {
      if (pending.size >= MAX_PENDING) return json(res, 429,{error:'too_many_pending_logins'}),true;
      const id=randomId();
      const flow={state:oidc.randomState(),nonce:oidc.randomNonce(),
        verifier:oidc.randomPKCECodeVerifier(),exp:Date.now()+FLOW_TTL};
      pending.set(id,flow);
      let destination;
      try { destination=await identityProvider.authorization(flow); }
      catch { pending.delete(id); return json(res,503,{error:'local_phiid_provider_unavailable'}),true; }
      const target=new URL(destination);
      if (target.origin !== 'http://127.0.0.1:8080' ||
          target.pathname !== '/realms/phiid-dev/protocol/openid-connect/auth') {
        pending.delete(id);return json(res,503,{error:'untrusted_authorization_endpoint'}),true;
      }
      return redirect(res,target.href,[cookie('pm_oidc_flow',id,300,'/auth/phiid')]),true;
    }

    if (req.method === 'GET' && path === '/auth/phiid/callback') {
      const cookieMap=cookies(req),flowId=cookieMap.get('pm_oidc_flow');
      const flow=flowId?pending.get(flowId):null;
      if (flowId) pending.delete(flowId);
      const clear=cookie('pm_oidc_flow','',0,'/auth/phiid');
      if (!flow || flow.exp <= Date.now() ||
          url.searchParams.getAll('state').length !== 1 ||
          url.searchParams.getAll('code').length !== 1 ||
          !secureCompare(url.searchParams.get('state'),flow.state) ||
          !url.searchParams.get('code')) {
        return json(res,400,{error:'invalid_or_expired_oidc_flow'},[clear]),true;
      }
      let claims,profile;
      try {
        claims=await identityProvider.exchange(url,flow);
        profile=validatedLocalProfile(claims);
      } catch {
        return json(res,401,{error:'oidc_signin_not_verified'},[clear]),true;
      }
      if(sessions.size>=MAX_SESSIONS) return json(res,429,{error:'too_many_local_sessions'},[clear]),true;
      const oldSid=cookieMap.get('pm_identity');
      if(oldSid)sessions.delete(oldSid);
      const remaining=Math.min(SESSION_TTL,claims.exp*1000-Date.now());
      if(remaining<=0)return json(res,401,{error:'expired_local_identity'},[clear]),true;
      const sid=randomId();
      sessions.set(sid,{profile,exp:Date.now()+remaining});
      return redirect(res,DEV_ORIGIN+'/?phiid=connected',[
        clear,cookie('pm_identity',sid,Math.max(1,Math.floor(remaining/1000)),'/api/identity')
      ]),true;
    }
    if(req.method==='POST' && path==='/api/identity/logout' && !url.search){
      if(req.headers.origin!==DEV_ORIGIN || req.headers['x-phimail-action']!=='logout' ||
         req.headers['sec-fetch-site']==='cross-site') {
        return json(res,403,{error:'cross_origin_action_denied'}),true;
      }
      const sid=cookies(req).get('pm_identity');
      if(sid)sessions.delete(sid);
      return json(res,200,{authenticated:false,note:'Local PhiMail OIDC session ended. Keycloak SSO may remain active.'},
        [cookie('pm_identity','',0,'/api/identity')]),true;
    }
    return json(res,404,{error:'not_found'}),true;
  }
  // Server-internal only: the mailbox-review boundary uses this already
  // verified session. Never expose this method through HTTP or client JS.
  function lookupSession(req){
    prune();
    return enabled && requestIsLocal(req) ? activeSession(req) : null;
  }
  return {enabled,handle,lookupSession};
}
