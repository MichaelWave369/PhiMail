/**
 * PhiMail R10: offline credential-envelope cryptography primitive.
 *
 * NOT connected to live OAuth sessions, any disk/database, PhiID identity
 * authorization, or hosted mail. The trusted caller MUST independently
 * verify BOTH the owner principal and the provider mailbox identity, and
 * obtain expectedRevision from an authoritative rollback-resistant store.
 *
 * A caller-supplied binding is authenticated additional data (AAD), NOT an
 * authorization grant. No browser or HTTP API can invoke this module.
 */
import {
  createCipheriv,createDecipheriv,hkdfSync,randomBytes
} from 'node:crypto';

export const CREDENTIAL_ENVELOPE_SCHEMA='phimail.credential-envelope/v1';
const KEY_ID=/^[A-Za-z0-9_-]{1,48}$/;
const B64=/^[A-Za-z0-9_-]+$/;
const PROVIDERS=new Set(['gmail','outlook','imap']);
const FIELDS=['ciphertext','expiresAt','iv','kid','revision','salt','schema','tag'];
const INFO=Buffer.from('PhiMail credential-envelope/v1 AES-256-GCM HKDF-SHA256','utf8');
const MAX_CREDENTIAL_BYTES=16_384;
const MAX_TTL=366*24*60*60*1000;

export class CredentialEnvelopeError extends Error{
  constructor(message='Credential envelope rejected'){
    super(message);
    this.name='CredentialEnvelopeError';
  }
}
function reject(){throw new CredentialEnvelopeError();}
function record(value){
  return value!==null&&typeof value==='object'&&!Array.isArray(value)&&
    (Object.getPrototypeOf(value)===Object.prototype||
     Object.getPrototypeOf(value)===null);
}
function exactFields(value,names){
  return record(value)&&
    Object.keys(value).sort().join(',')===[...names].sort().join(',');
}
function bounded(value,max){
  return typeof value==='string'&&value.length>0&&value.length<=max;
}
function canonicalDate(value){
  if(typeof value!=='string'||value.length!==24||
     !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))reject();
  const ms=Date.parse(value);
  if(!Number.isFinite(ms)||new Date(ms).toISOString()!==value)reject();
  return ms;
}
function validRevision(value){
  if(!Number.isSafeInteger(value)||value<1)reject();
}
function validateBinding(binding){
  if(!exactFields(binding,['owner','mailbox']))reject();
  if(!exactFields(binding.owner,['issuer','subject']) ||
     !bounded(binding.owner.issuer,512) ||
     !bounded(binding.owner.subject,512))reject();
  if(!exactFields(binding.mailbox,['provider','accountId'])||
     !PROVIDERS.has(binding.mailbox.provider)||
     !bounded(binding.mailbox.accountId,512))reject();
  // The owning service decides that issuer/subject are authenticated and
  // that provider/accountId came from an authorized provider response.
  // This validator checks only types and stable serialization shape.
  return [
    binding.owner.issuer,binding.owner.subject,
    binding.mailbox.provider,binding.mailbox.accountId
  ];
}
function validateCredential(credential,provider){
  if(!record(credential)||!bounded(credential.kind,16))reject();
  if(provider==='imap'){
    if(!exactFields(credential,['kind','username','appPassword'])||
       credential.kind!=='imap'||!bounded(credential.username,320)||
       !bounded(credential.appPassword,4096))reject();
    return;
  }
  if(credential.kind!=='oauth'||!record(credential))reject();
  const keys=Object.keys(credential).sort().join(',');
  const allowed=[['kind','accessToken','refreshToken','accessExpiresAt'],
    ['kind','accessToken','accessExpiresAt']];
  if(!allowed.some(group=>group.sort().join(',')===keys)||
     !bounded(credential.accessToken,8192)||
     (credential.refreshToken!==undefined&&!bounded(credential.refreshToken,8192)))reject();
  canonicalDate(credential.accessExpiresAt);
}
function decode(value,min,max){
  if(typeof value!=='string'||value.length>max*2||!B64.test(value))reject();
  const decoded=Buffer.from(value,'base64url');
  if(decoded.length<min||decoded.length>max||
     decoded.toString('base64url')!==value)reject();
  return decoded;
}
function aad(kid,revision,expiresAt,parts){
  return Buffer.from(JSON.stringify([
    CREDENTIAL_ENVELOPE_SCHEMA,kid,revision,expiresAt,...parts
  ]),'utf8');
}
function derive(key,salt){
  return Buffer.from(hkdfSync('sha256',key,salt,INFO,32));
}

/**
 * keys: Map<keyId, Buffer(32)> injected only by a trusted host or KMS
 * abstraction. No default key, hard-coded password, browser input or ENV
 * auto-loader. Versions/keys are not derived from PhiID identity strings.
 */
export function createCredentialEnvelopeCodec({keys,activeKeyId,now=Date.now}={}){
  if(!(keys instanceof Map)||keys.size<1||keys.size>16||
     !KEY_ID.test(activeKeyId||'')||typeof now!=='function'){
    throw new TypeError('Trusted vault key configuration required');
  }
  const material=new Map();
  for(const [kid,key] of keys){
    if(typeof kid!=='string'||!KEY_ID.test(kid)||!Buffer.isBuffer(key)||key.length!==32){
      throw new TypeError('Invalid vault key material');
    }
    material.set(kid,Buffer.from(key));
  }
  if(!material.has(activeKeyId))throw new TypeError('Missing active vault key');
  let destroyed=false;
  function usable(){
    if(destroyed)throw new CredentialEnvelopeError('Vault codec destroyed');
  }
  function seal({binding,credential,revision,expiresAt}={}){
    usable();
    const parts=validateBinding(binding);
    validRevision(revision);
    validateCredential(credential,binding.mailbox.provider);
    const time=now(),expiry=canonicalDate(expiresAt);
    if(!Number.isFinite(time)||expiry<=time||expiry-time>MAX_TTL)reject();
    const raw=Buffer.from(JSON.stringify(credential),'utf8');
    if(raw.length>MAX_CREDENTIAL_BYTES){raw.fill(0);reject();}
    const salt=randomBytes(32),iv=randomBytes(12);
    const key=derive(material.get(activeKeyId),salt);
    try{
      const cipher=createCipheriv('aes-256-gcm',key,iv,{authTagLength:16});
      cipher.setAAD(aad(activeKeyId,revision,expiresAt,parts));
      const encrypted=Buffer.concat([cipher.update(raw),cipher.final()]);
      return Object.freeze({
        schema:CREDENTIAL_ENVELOPE_SCHEMA,
        kid:activeKeyId,
        revision,expiresAt,
        salt:salt.toString('base64url'),
        iv:iv.toString('base64url'),
        ciphertext:encrypted.toString('base64url'),
        tag:cipher.getAuthTag().toString('base64url')
      });
    }finally{key.fill(0);raw.fill(0);}
  }
  function open({binding,envelope,expectedRevision}={}){
    usable();
    const parts=validateBinding(binding);
    validRevision(expectedRevision);
    if(!exactFields(envelope,FIELDS)||
       envelope.schema!==CREDENTIAL_ENVELOPE_SCHEMA||
       typeof envelope.kid!=='string'||!KEY_ID.test(envelope.kid)||
       envelope.revision!==expectedRevision||
       !material.has(envelope.kid))reject();
    const time=now(),expiry=canonicalDate(envelope.expiresAt);
    if(!Number.isFinite(time)||expiry<=time||expiry-time>MAX_TTL)reject();
    const salt=decode(envelope.salt,32,32);
    const iv=decode(envelope.iv,12,12);
    const tag=decode(envelope.tag,16,16);
    const ciphertext=decode(envelope.ciphertext,1,MAX_CREDENTIAL_BYTES+32);
    const key=derive(material.get(envelope.kid),salt);
    let plain;
    try{
      const decipher=createDecipheriv('aes-256-gcm',key,iv,{authTagLength:16});
      decipher.setAAD(aad(envelope.kid,envelope.revision,envelope.expiresAt,parts));
      decipher.setAuthTag(tag);
      plain=Buffer.concat([decipher.update(ciphertext),decipher.final()]);
      if(plain.length>MAX_CREDENTIAL_BYTES)reject();
      let credential;
      try{credential=JSON.parse(plain.toString('utf8'));}
      catch{reject();}
      validateCredential(credential,binding.mailbox.provider);
      return credential;
    }catch(error){
      if(error instanceof CredentialEnvelopeError)throw error;
      // Never reveal attacker-controlled ciphertext or crypto internals.
      reject();
    }finally{
      key.fill(0);
      if(plain)plain.fill(0);
    }
  }
  function rewrap({binding,envelope,expectedRevision,nextRevision,expiresAt}={}){
    usable();
    validRevision(nextRevision);
    if(nextRevision<=expectedRevision)reject();
    const credential=open({binding,envelope,expectedRevision});
    return seal({binding,credential,revision:nextRevision,expiresAt});
  }
  function destroy(){
    if(destroyed)return;
    destroyed=true;
    for(const secret of material.values())secret.fill(0);
    material.clear();
  }
  return Object.freeze({seal,open,rewrap,destroy});
}
