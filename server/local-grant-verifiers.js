/**
 * PhiMail R12: development-only trusted evidence adapters for the R11 grant
 * contract. Evidence comes from active SERVER-HELD OIDC and Microsoft Graph
 * sessions, never from a browser profile, requested email or R3 review receipt.
 *
 * The third verifier (explicit approval) intentionally DENIES ALL attempts.
 * These adapters are NOT wired to a live bridge grant endpoint. Do not treat
 * a verified identity and a mailbox session as consent to link accounts.
 */
import {DEV_ISSUER,DEV_ORIGIN} from './phiid-lab.js';
import {MailboxGrantDenied} from './mailbox-grants.js';

const MARKER=/^[A-Za-z0-9_-]{20,128}$/;
function deny(){throw new MailboxGrantDenied();}
function safeExpiry(ms,current){
  return Number.isSafeInteger(ms)&&ms>current&&ms<=current+24*60*60_000;
}
function isObject(value){
  return value!==null&&typeof value==='object'&&!Array.isArray(value);
}
function exactFields(value,names){
  return isObject(value)&&Object.keys(value).sort().join(',')===names.sort().join(',');
}

/**
 * identityLab: the real createPhiIdLab() instance (lookupSession reads a
 * server-held, independently verified OIDC session).
 * microsoftLab: the real createMicrosoftLab() instance (verifyAccount first
 * refreshes the Graph OAuth token if required, then checks live Graph /me
 * and verifies it still names the originally authenticated account).
 *
 * Gmail and IMAP MUST fail closed. They currently do not establish the
 * provider-verified stable account IDs required by R11.
 */
export function createLocalGrantVerifiers({
  env=process.env,identityLab,microsoftLab,now=Date.now
}={}){
  if(typeof identityLab?.lookupSession!=='function'||
     typeof microsoftLab?.verifyAccount!=='function'||
     typeof now!=='function'){
    throw new TypeError('Trusted identity and Graph session resolvers required');
  }
  const enabled=env.NODE_ENV!=='production'&&
    env.BRIDGE_PUBLIC_ORIGIN===DEV_ORIGIN;
  async function verifyIdentity(request){
    if(!enabled||identityLab.enabled!==true||!isObject(request))deny();
    const current=now();
    // Invalid/malformed incoming evidence must fail with the same generic
    // denial as a missing or revoked identity, never a raw parser exception.
    let session;
    try{session=identityLab.lookupSession(request);}
    catch{deny();}
    const profile=session?.profile;
    if(profile?.authenticated!==true||profile.issuer!==DEV_ISSUER||
       !isObject(profile)||typeof profile.sub!=='string'||
       !profile.sub||profile.sub.length>255||
       !MARKER.test(session.sessionMarker||'')||
       !safeExpiry(session.exp,current))deny();
    return Object.freeze({
      issuer:DEV_ISSUER,subject:profile.sub,
      sessionKey:session.sessionMarker,expiresAt:session.exp
    });
  }
  async function verifyMailbox(evidence){
    if(!enabled||microsoftLab.configured!==true||
       !exactFields(evidence,['provider','request'])||
       evidence.provider!=='outlook'||!isObject(evidence.request))deny();
    let result;
    try{result=await microsoftLab.verifyAccount(evidence.request);}
    catch{deny();}
    const current=now();
    if(result?.provider!=='outlook'||
       typeof result.accountId!=='string'||
       !result.accountId.startsWith('microsoft-consumers:')||
       result.accountId.length>512||
       result.accountId.length<22||
       !MARKER.test(result.sessionKey||'')||
       !safeExpiry(result.expiresAt,current))deny();
    return Object.freeze({
      provider:'outlook',accountId:result.accountId,
      sessionKey:result.sessionKey,expiresAt:result.expiresAt
    });
  }
  async function verifyApproval(){
    // An R3 acknowledgment, OAuth callback, valid PhiID login, positive
    // session status, or arbitrary browser JSON is NEVER explicit R11 proof.
    deny();
  }
  return Object.freeze({
    enabled,
    verifiedProviders:Object.freeze(enabled?['outlook']:[]),
    verifyIdentity,verifyMailbox,verifyApproval
  });
}
