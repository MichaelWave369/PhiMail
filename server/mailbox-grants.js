/**
 * Φ PhiMail R11: standalone, in-memory owner-to-mailbox grant authority.
 *
 * SECURITY BOUNDARY:
 * This module does NOT authenticate PhiID, validate Google/Microsoft tokens,
 * perform IMAP ownership verification, or prove a user gesture. These MUST be
 * provided by independent, trusted, server-side verifiers. There is NO
 * browser API, bridge route, token vault, persistence, or mailbox integration.
 *
 * A grant ID alone is NEVER a bearer credential. Every authorize() call
 * re-verifies the identity AND the exact connected provider mailbox session.
 * This is a testable authorization contract, not production authorization.
 */
import {randomBytes} from 'node:crypto';

export const MAILBOX_GRANT_SCHEMA='phimail.mailbox-grant/v0.1';
export const MAILBOX_INTENT_SCHEMA='phimail.mailbox-intent/v0.1';
export const READ_CAPABILITIES=Object.freeze(['read:inbox','read:message']);
const ALLOWED_PROVIDERS=new Set(['gmail','outlook','imap']);
const ID=/^[A-Za-z0-9_-]{20,128}$/;
const INTENT_TTL_MS=5*60_000;
const GRANT_TTL_MS=15*60_000;

export class MailboxGrantDenied extends Error{
  constructor(){super('Mailbox authorization denied');this.name='MailboxGrantDenied';}
}
function deny(){throw new MailboxGrantDenied();}
function record(value){
  return !!value&&typeof value==='object'&&!Array.isArray(value)&&
    (Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
}
function exact(value,keys){
  return record(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
}
function string(value,max){
  return typeof value==='string'&&value.length>0&&value.length<=max;
}
function epoch(value,now){
  return Number.isSafeInteger(value)&&value>now&&value<=now+24*60*60_000;
}
function trustedIdentity(value,now){
  if(!exact(value,['issuer','subject','sessionKey','expiresAt'])||
     !string(value.issuer,512)||!string(value.subject,512)||
     !ID.test(value.sessionKey)||!epoch(value.expiresAt,now))deny();
  return Object.freeze({...value});
}
function trustedMailbox(value,now){
  if(!exact(value,['provider','accountId','sessionKey','expiresAt'])||
     !ALLOWED_PROVIDERS.has(value.provider)||
     !string(value.accountId,512)||!ID.test(value.sessionKey)||
     !epoch(value.expiresAt,now))deny();
  return Object.freeze({...value});
}
function capabilities(value){
  if(!Array.isArray(value)||value.length<1||value.length>2)deny();
  const found=new Set();
  for(const item of value){
    if(!READ_CAPABILITIES.includes(item)||found.has(item))deny();
    found.add(item);
  }
  return Object.freeze(READ_CAPABILITIES.filter(item=>found.has(item)));
}
function matchIdentity(current,original,{sameSession=true}={}){
  return current.issuer===original.issuer&&current.subject===original.subject&&
    (!sameSession||current.sessionKey===original.sessionKey);
}
function matchMailbox(current,original){
  return current.provider===original.provider&&
    current.accountId===original.accountId&&
    current.sessionKey===original.sessionKey;
}
function randomId(){return randomBytes(32).toString('base64url');}
function freezeIntent(value){
  return Object.freeze({
    intentId:value.intentId,
    challenge:value.challenge,
    owner:Object.freeze({issuer:value.owner.issuer,subject:value.owner.subject}),
    identitySessionKey:value.owner.sessionKey,
    identityExpiresAt:value.owner.expiresAt,
    mailbox:Object.freeze({provider:value.mailbox.provider,accountId:value.mailbox.accountId}),
    mailboxSessionKey:value.mailbox.sessionKey,
    mailboxExpiresAt:value.mailbox.expiresAt,
    capabilities:value.capabilities,
    createdAt:value.createdAt,
    expiresAt:value.expiresAt
  });
}

/**
 * verifyIdentity(evidence) -> {issuer,subject,sessionKey,expiresAt}
 * verifyMailbox(evidence) -> {provider,accountId,sessionKey,expiresAt}
 * verifyApproval(evidence, immutableIntent) -> {
 *   intentId,challenge,issuer,subject,identitySessionKey,provider,
 *   accountId,mailboxSessionKey,capabilities,approvedAt
 * }
 *
 * These functions are TRUST BOUNDARIES, not merely validators for client
 * JSON. NEVER supply callbacks that echo unverified request data.
 */
export function createMailboxGrantAuthority({
  verifyIdentity,verifyMailbox,verifyApproval,
  now=Date.now,maxPending=64,maxGrants=128
}={}){
  if([verifyIdentity,verifyMailbox,verifyApproval,now].some(fn=>typeof fn!=='function')||
    !Number.isSafeInteger(maxPending)||maxPending<1||maxPending>4096||
    !Number.isSafeInteger(maxGrants)||maxGrants<1||maxGrants>4096){
    throw new TypeError('Trusted mailbox authorization verifiers required');
  }
  const pending=new Map(),grants=new Map();
  let destroyed=false;
  function time(){
    if(destroyed)deny();
    const current=now();
    if(!Number.isSafeInteger(current)||current<0)deny();
    return current;
  }
  function prune(current){
    for(const [id,intent] of pending){
      if(intent.expiresAt<=current)pending.delete(id);
    }
    for(const [id,grant] of grants){
      if(grant.expiresAt<=current)grants.delete(id);
    }
  }
  async function identity(evidence){
    // No fallback to caller-provided profiles or an R3 review receipt.
    return trustedIdentity(await verifyIdentity(evidence),time());
  }
  async function mailbox(evidence){
    return trustedMailbox(await verifyMailbox(evidence),time());
  }
  async function begin({identityEvidence,mailboxEvidence,requestedCapabilities}={}){
    const chosen=capabilities(requestedCapabilities);
    const owner=await identity(identityEvidence);
    const account=await mailbox(mailboxEvidence);
    const current=time();
    prune(current);
    if(pending.size>=maxPending)deny();
    const expiresAt=Math.min(current+INTENT_TTL_MS,owner.expiresAt,account.expiresAt);
    if(expiresAt<=current)deny();
    const intent=freezeIntent({
      intentId:randomId(),challenge:randomId(),owner,mailbox:account,
      capabilities:chosen,createdAt:current,expiresAt
    });
    pending.set(intent.intentId,intent);
    return Object.freeze({
      schema:MAILBOX_INTENT_SCHEMA,intentId:intent.intentId,
      challenge:intent.challenge,
      mailbox:intent.mailbox,capabilities:intent.capabilities,
      expiresAt:new Date(intent.expiresAt).toISOString()
    });
  }
  async function approve({intentId,approvalEvidence}={}){
    if(typeof intentId!=='string'||!ID.test(intentId))deny();
    const current=time();
    prune(current);
    const intent=pending.get(intentId);
    if(!intent)deny();
    // Consume BEFORE awaiting the external approval verifier to block
    // double-approval and replay under concurrent requests.
    pending.delete(intentId);
    if(approvalEvidence===undefined||approvalEvidence===null)deny();
    const result=await verifyApproval(approvalEvidence,intent);
    const accepted=exact(result,[
      'intentId','challenge','issuer','subject','identitySessionKey',
      'provider','accountId','mailboxSessionKey','capabilities','approvedAt'
    ])&&
      result.intentId===intent.intentId&&
      result.challenge===intent.challenge&&
      result.issuer===intent.owner.issuer&&
      result.subject===intent.owner.subject&&
      result.identitySessionKey===intent.identitySessionKey&&
      result.provider===intent.mailbox.provider&&
      result.accountId===intent.mailbox.accountId&&
      result.mailboxSessionKey===intent.mailboxSessionKey&&
      Array.isArray(result.capabilities)&&
      result.capabilities.length===intent.capabilities.length&&
      result.capabilities.every((scope,i)=>scope===intent.capabilities[i])&&
      Number.isSafeInteger(result.approvedAt)&&
      result.approvedAt>=intent.createdAt&&result.approvedAt<=time();
    if(!accepted)deny();
    const next=time();
    prune(next);
    // Grants never outlive either independently verified session or the
    // 15-minute policy, even before per-read re-verification.
    const expiresAt=Math.min(next+GRANT_TTL_MS,
      intent.identityExpiresAt,intent.mailboxExpiresAt);
    if(next>=intent.expiresAt||expiresAt<=next||grants.size>=maxGrants)deny();
    const id=randomId();
    // The full session references stay server-side; only the redacted
    // owner/mailbox identifiers appear in public grant summaries.
    grants.set(id,Object.freeze({
      id,
      owner:Object.freeze({...intent.owner,sessionKey:intent.identitySessionKey,
        expiresAt:intent.identityExpiresAt}),
      mailbox:Object.freeze({...intent.mailbox,sessionKey:intent.mailboxSessionKey,
        expiresAt:intent.mailboxExpiresAt}),
      capabilities:intent.capabilities,expiresAt,createdAt:next
    }));
    return Object.freeze({
      schema:MAILBOX_GRANT_SCHEMA,grantId:id,
      mailbox:intent.mailbox,capabilities:intent.capabilities,
      expiresAt:new Date(expiresAt).toISOString(),
      token_or_credentials_included:false,
      phiid_login_alone_grants_access:false
    });
  }
  async function authorize({
    grantId,identityEvidence,mailboxEvidence,capability
  }={}){
    if(typeof grantId!=='string'||!ID.test(grantId)||
       !READ_CAPABILITIES.includes(capability))deny();
    const start=time();
    prune(start);
    const initial=grants.get(grantId);
    if(!initial||!initial.capabilities.includes(capability))deny();
    const [owner,account]=await Promise.all([
      identity(identityEvidence),mailbox(mailboxEvidence)
    ]);
    // Check AFTER asynchronous proof verification too. Revocation or
    // expiry while a verifier is running MUST fail closed.
    const current=time();
    prune(current);
    if(grants.get(grantId)!==initial||current>=initial.expiresAt||
       !matchIdentity(owner,initial.owner)||!matchMailbox(account,initial.mailbox))deny();
    return Object.freeze({
      authorized:true,grantId,
      owner:Object.freeze({issuer:owner.issuer,subject:owner.subject}),
      mailbox:Object.freeze({provider:account.provider,accountId:account.accountId}),
      capability,
      expiresAt:new Date(Math.min(initial.expiresAt,owner.expiresAt,account.expiresAt)).toISOString()
    });
  }
  async function revoke({grantId,identityEvidence}={}){
    if(typeof grantId!=='string'||!ID.test(grantId))deny();
    const actor=await identity(identityEvidence);
    const current=time();prune(current);
    const grant=grants.get(grantId);
    if(!grant||!matchIdentity(actor,grant.owner,{sameSession:false}))deny();
    // Owner may revoke after refreshing the PhiID session; grant reuse
    // still requires the ORIGINAL verified identity+mailbox sessions.
    grants.delete(grantId);
    return Object.freeze({revoked:true,remote_provider_token_revoked:false,
      vault_record_deleted:false});
  }
  async function revokeAll({identityEvidence}={}){
    const actor=await identity(identityEvidence);
    prune(time());
    let removed=0;
    for(const [id,grant] of grants){
      if(matchIdentity(actor,grant.owner,{sameSession:false})){
        grants.delete(id);removed++;
      }
    }
    return Object.freeze({revoked_grants:removed,
      remote_provider_tokens_revoked:false,vault_records_deleted:false});
  }
  function destroy(){
    if(destroyed)return;
    destroyed=true;
    pending.clear();grants.clear();
  }
  return Object.freeze({begin,approve,authorize,revoke,revokeAll,destroy});
}
