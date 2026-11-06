/**
 * PhiMail R3: local-only, ephemeral mailbox association REVIEW.
 *
 * This is NOT a mailbox-to-account link, ownership grant, or permission to read.
 * It requires separate server-validated PhiID and Gmail sessions, then records
 * that the person explicitly reviewed the proposed association in this session.
 */
import { randomBytes } from 'node:crypto';
import { DEV_ISSUER, DEV_ORIGIN } from './phiid-lab.js';

const REVIEW_SCHEMA = 'phimail.local-mailbox-review/0.1';
const REVIEW_TTL = 10 * 60_000;
const MAX_BODY = 512;

function respond(res, status, payload) {
  res.writeHead(status, {
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer',
    'X-Frame-Options':'DENY',
  });
  res.end(JSON.stringify(payload));
}
function requestIsLocal(req) {
  const address=req.socket?.remoteAddress;
  return req.headers.host==='127.0.0.1:5173' &&
    (address==='127.0.0.1' || address==='::ffff:127.0.0.1');
}
async function strictJson(req) {
  if (req.headers['content-type'] !== 'application/json' ||
      (req.headers['content-encoding'] && req.headers['content-encoding']!=='identity')) {
    const e=new Error('json_content_type_required');e.status=415;throw e;
  }
  const len=req.headers['content-length'];
  if(len!==undefined && (!/^\d+$/.test(len) || Number(len)>MAX_BODY)){
    const e=new Error('payload_too_large');e.status=413;throw e;
  }
  const parts=[];let bytes=0;
  for await (const part of req){
    bytes+=part.length;
    if(bytes>MAX_BODY){const e=new Error('payload_too_large');e.status=413;throw e;}
    parts.push(part);
  }
  let input;
  try{input=JSON.parse(Buffer.concat(parts).toString('utf8'));}
  catch{const e=new Error('invalid_json');e.status=400;throw e;}
  if(!input || typeof input!=='object' || Array.isArray(input) ||
     Object.keys(input).sort().join(',')!=='acknowledged,provider,schema' ||
     input.acknowledged!==true || input.provider!=='gmail' || input.schema!==REVIEW_SCHEMA){
    const e=new Error('explicit_review_acknowledgment_required');e.status=400;throw e;
  }
  return input;
}

export function createMailboxReview({env=process.env,identityLab,gmailSessionFor}){
  const enabled=identityLab.enabled &&
    env.NODE_ENV!=='production' &&
    env.BRIDGE_PUBLIC_ORIGIN===DEV_ORIGIN;
  const records=new WeakMap();

  function context(req) {
    const identity=identityLab.lookupSession(req);
    const gmail=gmailSessionFor(req);
    const identityOK=Boolean(identity?.profile?.authenticated===true &&
      identity.profile.issuer===DEV_ISSUER && typeof identity.profile.sub==='string' &&
      identity.profile.sub.length>0 && Number.isFinite(identity.exp) && identity.exp>Date.now());
    const gmailOK=Boolean(gmail?.email && typeof gmail.email==='string' &&
      gmail.sessionMarker && Number.isFinite(gmail.expires) && gmail.expires>Date.now());
    return {identity:identityOK?identity:null,gmail:gmailOK?gmail:null};
  }
  function hasReview(identity,gmail){
    if(!identity || !gmail)return null;
    const record=records.get(identity);
    return record && record.expires>Date.now() && record.marker===gmail.sessionMarker &&
      record.subject===identity.profile.sub && record.issuer===identity.profile.issuer
      ? record : null;
  }
  function publicState(identity,gmail){
    const record=hasReview(identity,gmail);
    return {
      schema:REVIEW_SCHEMA,
      environment:'local_development_only',
      authenticated_identity: Boolean(identity),
      connected_gmail_session: Boolean(gmail),
      eligible_to_review: Boolean(identity&&gmail),
      identity:identity ? {issuer:identity.profile.issuer,sub:identity.profile.sub,
        preferred_username:identity.profile.preferred_username} : null,
      mailbox:gmail ? {provider:'gmail',email:gmail.email} : null,
      review:record ? {id:record.id,recorded_at:record.recordedAt,
        expires_at:new Date(record.expires).toISOString(),status:'recorded_not_enforced'} : null,
      account_linked:false,
      mailbox_access_granted:false,
      cloud_authorized:false,
      credentials_persisted:false,
    };
  }
  async function handle(req,res,path,url){
    if(path!=='/api/identity/mailbox-review')return false;
    if(!enabled)return respond(res,503,{error:'local_mailbox_review_disabled'}),true;
    if(!requestIsLocal(req))return respond(res,403,{error:'loopback_host_required'}),true;
    if(url.search || url.hash)return respond(res,404,{error:'not_found'}),true;
    const {identity,gmail}=context(req);
    if(req.method==='GET'){
      return respond(res,200,publicState(identity,gmail)),true;
    }
    if(req.method==='POST'){
      if(req.headers.origin!==DEV_ORIGIN ||
          req.headers['x-phimail-action']!=='review-mailbox' ||
          req.headers['sec-fetch-site']==='cross-site'){
        return respond(res,403,{error:'same_origin_review_required'}),true;
      }
      if(!identity || !gmail)return respond(res,401,{error:'two_independent_sessions_required'}),true;
      try{await strictJson(req);}catch(e){return respond(res,e.status||400,{error:e.message}),true;}
      const now=Date.now();
      const expires=Math.min(now+REVIEW_TTL,identity.exp,gmail.expires);
      if(expires<=now)return respond(res,401,{error:'session_expired'}),true;
      records.set(identity,{
        id:randomBytes(18).toString('base64url'),
        marker:gmail.sessionMarker,
        issuer:identity.profile.issuer,
        subject:identity.profile.sub,
        recordedAt:new Date(now).toISOString(),
        expires,
      });
      return respond(res,201,publicState(identity,gmail)),true;
    }
    if(req.method==='DELETE'){
      if(req.headers.origin!==DEV_ORIGIN ||
          req.headers['x-phimail-action']!=='clear-review' ||
          req.headers['sec-fetch-site']==='cross-site'){
        return respond(res,403,{error:'same_origin_clear_required'}),true;
      }
      if(!identity)return respond(res,401,{error:'verified_local_identity_required'}),true;
      records.delete(identity);
      return respond(res,200,publicState(identity,gmail)),true;
    }
    return respond(res,405,{error:'method_not_allowed'}),true;
  }
  return {handle};
}
