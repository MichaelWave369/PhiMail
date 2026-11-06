/**
 * PhiMail R1 read-only interoperability adapters.
 * These contracts NEVER authenticate users, grant permissions, or verify service health.
 *
 * PhiID preview files are untrusted display-only metadata.
 * PhiCloud inventory is a declaration, not a live health probe.
 */
export const PHIID_PREVIEW_SCHEMA = 'phi-account/0.1';
export const PHICLOUD_REGISTRY_SCHEMA = 'phicloud.services.v0.1';

const ACCOUNT_KEYS = ['schema_version','issuer','sub','preferred_username','email','email_verified'];
const EXPORT_KEYS = ['kind','authentic_identity_proof','warning','account'];
const MANIFEST_KEYS = ['schema','services'];
const SERVICE_KEYS = ['id','title','role','stage','repository','endpoint_hint'];
const ROLES = new Set(['identity','mail','security','storage','sync','compute','data','network','dns','functions','observability','inference','gateway']);
const STAGES = new Set(['planned','integration-needed','prototype']);

function exactKeys(obj, keys, label) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj) ||
      JSON.stringify(Object.keys(obj).sort()) !== JSON.stringify([...keys].sort())) {
    throw new TypeError('Invalid ' + label + ' contract fields');
  }
}
function urlIsHTTPS(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) &&
      !url.username && !url.password && !url.search && !url.hash &&
      !url.pathname.includes('/../') && !url.pathname.includes('/./');
  } catch { return false; }
}
function validEndpointHint(value) {
  if (value === null) return true;
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === 'https:') return !url.hostname.endsWith('.invalid');
    return url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  } catch { return false; }
}
function validRepo(value) {
  if (value === null) return true;
  if (typeof value !== 'string' || value.length > 250) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname === 'github.com' &&
      !u.username && !u.password && !u.search && !u.hash &&
      /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(u.pathname);
  } catch { return false; }
}

/**
 * PhiID's createDemoExport object is not a credential and cannot be used for login.
 * A boolean "authenticated" field is always false by construction.
 */
export function inspectPhiIdPreviewExport(input) {
  exactKeys(input, EXPORT_KEYS, 'PhiID export');
  if (input.kind !== 'phiid-preview-export-only' || input.authentic_identity_proof !== false ||
      typeof input.warning !== 'string' || !input.warning || input.warning.length > 500) {
    throw new TypeError('This is not a supported synthetic PhiID preview export');
  }
  const account = input.account;
  exactKeys(account, ACCOUNT_KEYS, 'PhiID account');
  if (account.schema_version !== PHIID_PREVIEW_SCHEMA || !urlIsHTTPS(account.issuer)) {
    throw new TypeError('Unsupported PhiID preview schema or issuer');
  }
  if (typeof account.sub !== 'string' || !account.sub.length || account.sub.length > 255 ||
      /[\u0000-\u001f\u007f]/.test(account.sub)) throw new TypeError('Invalid PhiID display subject');
  if (typeof account.preferred_username !== 'string' || !account.preferred_username.length ||
      account.preferred_username.length > 64 || /[\u0000-\u001f\u007f]/.test(account.preferred_username)) {
    throw new TypeError('Invalid PhiID display username');
  }
  if (account.email !== null && (typeof account.email !== 'string' ||
      account.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email))) {
    throw new TypeError('Invalid PhiID preview email');
  }
  if (typeof account.email_verified !== 'boolean' ||
      (account.email === null && account.email_verified)) throw new TypeError('Invalid PhiID email flag');
  return Object.freeze({
    schema: PHIID_PREVIEW_SCHEMA,
    issuer: account.issuer,
    subject: account.sub,
    preferredUsername: account.preferred_username,
    email: account.email,
    /** Deliberately do not forward input email_verified as authorization. */
    displayOnly: true,
    authenticated: false,
    permissions: Object.freeze([]),
    principalKeyForDisplayOnly: JSON.stringify([account.issuer, account.sub]),
  });
}

/**
 * Pure mirror of PhiCloud R0's phicloud.registry.validate_manifest shape.
 * Does not resolve or call endpoint_hint or load any external URL.
 */
export function inspectPhiCloudRegistry(input) {
  exactKeys(input, MANIFEST_KEYS, 'PhiCloud registry');
  if (input.schema !== PHICLOUD_REGISTRY_SCHEMA || !Array.isArray(input.services) ||
      input.services.length < 1 || input.services.length > 64) {
    throw new TypeError('Unsupported PhiCloud registry schema or service count');
  }
  const ids = new Set();
  const services = input.services.map((s, index) => {
    exactKeys(s, SERVICE_KEYS, 'PhiCloud service ' + index);
    if (typeof s.id !== 'string' || !/^[a-z][a-z0-9-]{1,47}$/.test(s.id) || ids.has(s.id)) {
      throw new TypeError('Invalid or duplicate service identifier');
    }
    ids.add(s.id);
    if (typeof s.title !== 'string' || !s.title.length || s.title.length > 64 ||
        !ROLES.has(s.role) || !STAGES.has(s.stage) ||
        !validRepo(s.repository) || !validEndpointHint(s.endpoint_hint)) {
      throw new TypeError('Invalid PhiCloud service declaration');
    }
    return Object.freeze({
      id: s.id, title: s.title, role: s.role,
      declaredStage: s.stage,
      repository: s.repository,
      /** Endpoint hints are intentionally excluded from UI/API output. */
      liveHealth: 'not-checked',
      authenticated: false,
      authorized: false,
    });
  });
  return Object.freeze({
    schema: PHICLOUD_REGISTRY_SCHEMA,
    source: 'local-registry-declaration',
    registryReadSucceeded: true,
    services: Object.freeze(services),
  });
}

export async function readLocalPhiCloudRegistry(fetcher = fetch) {
  const response = await fetcher('/field-registry/v1/services', {
    method: 'GET', credentials: 'same-origin', cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Local PhiCloud registry returned ' + response.status);
  const declaredSize = Number(response.headers?.get?.('content-length') || 0);
  if (declaredSize > 128000) throw new Error('Local registry response is too large');
  const raw = await response.text();
  if (raw.length > 128000) throw new Error('Local registry response is too large');
  let data;
  try { data = JSON.parse(raw); }
  catch { throw new TypeError('Local registry returned invalid JSON'); }
  return inspectPhiCloudRegistry(data);
}
