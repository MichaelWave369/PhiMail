/**
 * PhiMail R13: explicitly consented, temporary LOCAL owner-to-Outlook
 * association experiment. No mailbox reads are gated by these grants.
 *
 * The R11 authority remains server-only. Independent R12 verified PhiID and
 * Microsoft Graph sessions are required. Same-origin user action completes
 * a one-time intent, but this local browser ceremony is not a hardware-
 * attested human gesture, durable account link or production consent system.
 */
import {createMailboxGrantAuthority,MailboxGrantDenied} from './mailbox-grants.js';
import {createLocalGrantVerifiers} from './local-grant-verifiers.js';
import {DEV_ORIGIN} from './phiid-lab.js';

export const LOCAL_CONSENT_SCHEMA='phimail.local-mailbox-consent/v0.1';
const MAX_BODY_BYTES=512;
const MAX_ACTIVE=128;
const CAPABILITIES=Object.freeze(['read:inbox','read:message']);
const ID=/^[A-Za-z0-9_-]{20,128}$/;
function deny(){throw new MailboxGrantDenied();}
function object(value){
  return value!==null&&typeof value==='object'&&!Array.isArray(value) &&
    (Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
}
function exact(value,keys){
  return object(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
}
function respond(res,status,payload){
  res.writeHead(status,{
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'
  });
  res.end(JSON.stringify(payload));
}
function localRequest(req){
  const ip=req.socket?.remoteAddress;
  return req.headers?.host==='127.0.0.1:5173' &&
    (ip==='127.0.0.1'||ip==='::ffff:127.0.0.1') &&
    (!req.headers.origin||req.headers.origin===DEV_ORIGIN) &&
    (!req.headers['sec-fetch-site']||
      ['same-origin','none'].includes(req.headers['sec-fetch-site']));
}
function mutation(req,action){
  return req.headers.origin===DEV_ORIGIN &&
    req.headers['x-phimail-action']===action &&
    req.headers['sec-fetch-site']!=='cross-site' &&
    (!req.headers['sec-fetch-mode']||
      req.headers['sec-fetch-mode']==='cors'||req.headers['sec-fetch-mode']==='same-origin');
}
async function parseBody(req){
  if(req.headers['content-type']!=='application/json' ||
     (req.headers['content-encoding']&&req.headers['content-encoding']!=='identity') ||
     req.headers['transfer-encoding'])deny();
  const advertised=req.headers['content-length'];
  if(advertised!==undefined &&
     (!/^\d+$/.test(advertised)||Number(advertised)>MAX_BODY_BYTES))deny();
  const chunks=[];let bytes=0;
  for await(const chunk of req){
    bytes+=chunk.length;
    if(bytes>MAX_BODY_BYTES)deny();
    chunks.push(chunk);
  }
  let value;
  try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch{deny();}
  return value;
}
function staticFlags(){
  return {
    environment:'local_development_only',
    provider:'outlook',
    account_linked_persistently:false,
    live_mailbox_reads_use_this_grant:false,
    extra_mailbox_access_granted:false,
    credentials_persisted:false,
    phiid_sso_modified:false,
    remote_oauth_tokens_revoked:false,
    gmail_and_imap_owner_binding_supported:false,
  };
}
export function createLocalMailboxConsent({
  env=process.env,identityLab,microsoftLab,now=Date.now
}={}){
  const verifiers=createLocalGrantVerifiers({env,identityLab,microsoftLab,now});
  const enabled=verifiers.enabled && identityLab.enabled===true &&
    microsoftLab.configured===true;
  const active=new Map();
  // This proof is NEVER derived from a user-supplied issuer, email, scopes
  // or callback-provided access token. It requires the two current, distinct
  // server-held credentials to still identify the exact intent.
  async function verifyApproval(evidence,intent){
    if(!enabled||!exact(evidence,['request','payload']))deny();
    const {request,payload}=evidence;
    if(!localRequest(request)||!mutation(request,'approve-mailbox-consent') ||
       !exact(payload,['schema','intentId','challenge','acknowledged'])||
       payload.schema!==LOCAL_CONSENT_SCHEMA ||
       payload.acknowledged!==true ||
       payload.intentId!==intent.intentId ||
       payload.challenge!==intent.challenge)deny();
    const [owner,account]=await Promise.all([
      verifiers.verifyIdentity(request),
      verifiers.verifyMailbox({request,provider:'outlook'})
    ]);
    if(owner.issuer!==intent.owner.issuer||
       owner.subject!==intent.owner.subject||
       owner.sessionKey!==intent.identitySessionKey||
       account.provider!==intent.mailbox.provider||
       account.accountId!==intent.mailbox.accountId||
       account.sessionKey!==intent.mailboxSessionKey)deny();
    const timestamp=now();
    if(timestamp>=intent.expiresAt||timestamp>=owner.expiresAt||
       timestamp>=account.expiresAt)deny();
    return Object.freeze({
      intentId:intent.intentId,challenge:intent.challenge,
      issuer:owner.issuer,subject:owner.subject,
      identitySessionKey:owner.sessionKey,
      provider:account.provider,accountId:account.accountId,
      mailboxSessionKey:account.sessionKey,
      capabilities:[...intent.capabilities],
      approvedAt:timestamp
    });
  }
  const authority=createMailboxGrantAuthority({
    verifyIdentity:verifiers.verifyIdentity,
    verifyMailbox:verifiers.verifyMailbox,
    verifyApproval,now
  });
  function prune(){
    const current=now();
    for(const [marker,entry] of active){
      if(entry.expiresAt<=current)active.delete(marker);
    }
  }
  async function status(req){
    prune();
    let owner=null,account=null;
    try{owner=await verifiers.verifyIdentity(req);}
    catch{/* no verified local identity */}
    try{account=await verifiers.verifyMailbox({request:req,provider:'outlook'});}
    catch{/* no verified account or Graph unreachable */}
    let current=null;
    if(owner&&account){
      const entry=active.get(owner.sessionKey);
      if(entry){
        try{
          const result=await authority.authorize({
            grantId:entry.grantId,
            identityEvidence:req,
            mailboxEvidence:{request:req,provider:'outlook'},
            capability:'read:inbox'
          });
          if(result.mailbox.accountId===account.accountId){
            current={
              status:'local_ephemeral_grant_only',
              capabilities:[...entry.capabilities],
              expires_at:new Date(entry.expiresAt).toISOString()
            };
          }
        }catch{active.delete(owner.sessionKey);}
      }
    }
    return {
      schema:LOCAL_CONSENT_SCHEMA,...staticFlags(),
      identity_verified:Boolean(owner),
      outlook_verified:Boolean(account),
      eligible_to_request_consent:Boolean(owner&&account),
      owner:owner?{issuer:owner.issuer,subject:owner.subject}:null,
      mailbox:account?{provider:account.provider,accountId:account.accountId}:null,
      grant:current
    };
  }
  async function handle(req,res,path,url){
    if(path!=='/api/identity/mailbox-consent' &&
       path!=='/api/identity/mailbox-consent/intent' &&
       path!=='/api/identity/mailbox-consent/approve' &&
       path!=='/api/identity/mailbox-consent/revoke')return false;
    if(!enabled){respond(res,503,{error:'local_outlook_consent_disabled'});return true;}
    if(!localRequest(req)){respond(res,403,{error:'local_same_origin_only'});return true;}
    if(url.search||url.hash){respond(res,400,{error:'unexpected_parameters'});return true;}
    try{
      if(path==='/api/identity/mailbox-consent'){
        if(req.method!=='GET'){respond(res,405,{error:'method_not_allowed'});return true;}
        respond(res,200,await status(req));return true;
      }
      if(req.method!=='POST'){respond(res,405,{error:'method_not_allowed'});return true;}
      const name=path.slice('/api/identity/mailbox-consent/'.length);
      const action=name==='intent'?'begin-mailbox-consent':
        name==='approve'?'approve-mailbox-consent':'revoke-mailbox-consent';
      if(!mutation(req,action)){respond(res,403,{error:'explicit_same_origin_action_required'});return true;}
      const data=await parseBody(req);
      if(name==='intent'){
        if(!exact(data,['schema','provider','capabilities'])||
           data.schema!==LOCAL_CONSENT_SCHEMA||data.provider!=='outlook'||
           !Array.isArray(data.capabilities)||
           data.capabilities.length!==2||
           data.capabilities.some((x,i)=>x!==CAPABILITIES[i]))deny();
        const intent=await authority.begin({
          identityEvidence:req,mailboxEvidence:{request:req,provider:'outlook'},
          requestedCapabilities:CAPABILITIES
        });
        respond(res,201,{
          schema:LOCAL_CONSENT_SCHEMA,...staticFlags(),
          intent:{id:intent.intentId,challenge:intent.challenge,
            mailbox:intent.mailbox,capabilities:intent.capabilities,
            expires_at:intent.expiresAt},
          instructions:'Review this provider account and both read-only scopes, then explicitly approve within five minutes.'
        });
        return true;
      }
      if(name==='approve'){
        if(!exact(data,['schema','intentId','challenge','acknowledged']) ||
           data.schema!==LOCAL_CONSENT_SCHEMA ||
           !ID.test(data.intentId||'')||!ID.test(data.challenge||'') ||
           data.acknowledged!==true)deny();
        const result=await authority.approve({
          intentId:data.intentId,approvalEvidence:{request:req,payload:data}
        });
        // No async task may authorize a DIFFERENT principal after proof.
        // Re-check the same granted provider/owner in the authority itself.
        const approved=await authority.authorize({
          grantId:result.grantId,identityEvidence:req,
          mailboxEvidence:{request:req,provider:'outlook'},
          capability:'read:inbox'
        });
        const currentOwner=await verifiers.verifyIdentity(req);
        if(currentOwner.issuer!==approved.owner.issuer||
           currentOwner.subject!==approved.owner.subject ||
           now()>=currentOwner.expiresAt)deny();
        prune();
        if(active.size>=MAX_ACTIVE&&!active.has(currentOwner.sessionKey))deny();
        const previous=active.get(currentOwner.sessionKey);
        if(previous)await authority.revoke({
          grantId:previous.grantId,identityEvidence:req
        });
        active.set(currentOwner.sessionKey,{
          grantId:result.grantId,issuer:approved.owner.issuer,
          subject:approved.owner.subject,
          accountId:approved.mailbox.accountId,
          capabilities:[...result.capabilities],
          expiresAt:Date.parse(result.expiresAt)
        });
        respond(res,201,{
          schema:LOCAL_CONSENT_SCHEMA,...staticFlags(),
          grant:{
            status:'local_ephemeral_grant_only',
            capabilities:result.capabilities,expires_at:result.expiresAt
          }
        });
        return true;
      }
      if(name==='revoke'){
        if(!exact(data,['schema'])||data.schema!==LOCAL_CONSENT_SCHEMA)deny();
        const owner=await verifiers.verifyIdentity(req);
        const revoked=await authority.revokeAll({identityEvidence:req});
        for(const [marker,entry] of active){
          if(entry.issuer===owner.issuer&&entry.subject===owner.subject)
            active.delete(marker);
        }
        respond(res,200,{
          schema:LOCAL_CONSENT_SCHEMA,...staticFlags(),
          revoked_grants:revoked.revoked_grants,
          grant:null
        });
        return true;
      }
    }catch(error){
      const status=error instanceof MailboxGrantDenied?403:503;
      respond(res,status,{error:status===403?'mailbox_consent_denied':'local_provider_unavailable'});
      return true;
    }
    respond(res,404,{error:'not_found'});
    return true;
  }
  return Object.freeze({enabled,handle});
}
