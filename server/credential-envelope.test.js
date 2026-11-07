import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {
  createCredentialEnvelopeCodec,CredentialEnvelopeError,
  CREDENTIAL_ENVELOPE_SCHEMA
} from './credential-envelope.js';

const NOW=Date.parse('2026-11-06T19:00:00.000Z');
const EXPIRY=new Date(NOW+60*60_000).toISOString();
const KEYS=()=>new Map([
  ['old_2026',randomBytes(32)],
  ['new_2026',randomBytes(32)]
]);
const OWNER={
  owner:{issuer:'http://127.0.0.1:8080/realms/phiid-dev',subject:'verified-user-123'},
  mailbox:{provider:'gmail',accountId:'google-provider-account-42'}
};
const GMAIL={
  kind:'oauth',accessToken:'private-access-do-not-log',
  refreshToken:'private-refresh-do-not-log',
  accessExpiresAt:new Date(NOW+30*60_000).toISOString()
};
const imapBinding={
  owner:{issuer:'http://127.0.0.1:8080/realms/phiid-dev',subject:'verified-user-123'},
  mailbox:{provider:'imap',accountId:'imap.example.test/tester@example.test'}
};
const IMAP={kind:'imap',username:'tester@example.test',appPassword:'provider-app-password'};
function codec(kid='old_2026',keys=KEYS(),time=NOW){
  return createCredentialEnvelopeCodec({keys,activeKeyId:kid,now:()=>time});
}
function args(envelope,binding=OWNER,revision=1){
  return {envelope,binding,expectedRevision:revision};
}
function mustReject(fn){
  assert.throws(fn,error=>error instanceof CredentialEnvelopeError&&
    !String(error.message).includes('private-refresh'));
}

describe('R10 credential envelope cryptography',()=>{
  it('seals OAuth tokens with AES-256-GCM and opens only under the exact trusted binding',()=>{
    const vault=codec();
    const sealed=vault.seal({binding:OWNER,credential:GMAIL,revision:1,expiresAt:EXPIRY});
    assert.equal(sealed.schema,CREDENTIAL_ENVELOPE_SCHEMA);
    assert.equal(sealed.kid,'old_2026');
    assert.equal(sealed.revision,1);
    assert.equal(sealed.expiresAt,EXPIRY);
    assert.equal(Buffer.from(sealed.iv,'base64url').length,12);
    assert.equal(Buffer.from(sealed.salt,'base64url').length,32);
    assert.equal(Buffer.from(sealed.tag,'base64url').length,16);
    assert.ok(!JSON.stringify(sealed).includes(GMAIL.accessToken));
    assert.ok(!JSON.stringify(sealed).includes(GMAIL.refreshToken));
    assert.ok(!JSON.stringify(sealed).includes(OWNER.owner.subject));
    assert.deepEqual(vault.open(args(sealed)),GMAIL);
    vault.destroy();
  });
  it('uses a unique random salt and IV even for identical credentials and revision',()=>{
    const vault=codec();
    const options={binding:OWNER,credential:GMAIL,revision:1,expiresAt:EXPIRY};
    const a=vault.seal(options),b=vault.seal(options);
    assert.notEqual(a.salt,b.salt);
    assert.notEqual(a.iv,b.iv);
    assert.notEqual(a.ciphertext,b.ciphertext);
    assert.deepEqual(vault.open(args(a)),vault.open(args(b)));
    vault.destroy();
  });
  it('rejects different verified owner subject, issuer, provider or provider account',()=>{
    const vault=codec();
    const sealed=vault.seal({binding:OWNER,credential:GMAIL,revision:1,expiresAt:EXPIRY});
    const alternatives=[
      {...OWNER,owner:{...OWNER.owner,subject:'another-user'}},
      {...OWNER,owner:{...OWNER.owner,issuer:'https://id.elsewhere.example'}},
      {...OWNER,mailbox:{...OWNER.mailbox,provider:'outlook'}},
      {...OWNER,mailbox:{...OWNER.mailbox,accountId:'another-google-account'}},
    ];
    for(const binding of alternatives)mustReject(()=>vault.open(args(sealed,binding)));
    vault.destroy();
  });
  it('rejects tampering with any part of the sealed envelope',()=>{
    const vault=codec();
    const sealed=vault.seal({binding:OWNER,credential:GMAIL,revision:1,expiresAt:EXPIRY});
    for(const name of ['salt','iv','ciphertext','tag']){
      const item=sealed[name];
      const changed={...sealed,[name]:(item[0]==='A'?'B':'A')+item.slice(1)};
      mustReject(()=>vault.open(args(changed)));
    }
    mustReject(()=>vault.open(args({...sealed,revision:2},OWNER,1)));
    mustReject(()=>vault.open(args({...sealed,expiresAt:new Date(NOW+120_000).toISOString()})));
    mustReject(()=>vault.open(args({...sealed,kid:'new_2026'})));
    mustReject(()=>vault.open(args({...sealed,schema:'phimail.future/1'})));
    mustReject(()=>vault.open(args({...sealed,debug:'bad extra field'})));
    mustReject(()=>vault.open(args({...sealed,tag:'--not-base64--'})));
    vault.destroy();
  });
  it('requires caller-authoritative monotonically stored revision and rejects rollback mismatch',()=>{
    const vault=codec();
    const old=vault.seal({binding:OWNER,credential:GMAIL,revision:1,expiresAt:EXPIRY});
    const fresh=vault.seal({binding:OWNER,credential:GMAIL,revision:2,expiresAt:EXPIRY});
    assert.deepEqual(vault.open(args(fresh,OWNER,2)),GMAIL);
    mustReject(()=>vault.open(args(old,OWNER,2)));
    mustReject(()=>vault.open(args(fresh,OWNER,1)));
    mustReject(()=>vault.rewrap({binding:OWNER,envelope:fresh,
      expectedRevision:2,nextRevision:2,expiresAt:EXPIRY}));
    vault.destroy();
  });
  it('rewraps old ciphertext under a new key without exposing the credentials in output',()=>{
    const keys=KEYS();
    const old=codec('old_2026',keys);
    const sealed=old.seal({binding:OWNER,credential:GMAIL,revision:1,expiresAt:EXPIRY});
    const rotated=codec('new_2026',keys);
    const newer=rotated.rewrap({
      binding:OWNER,envelope:sealed,expectedRevision:1,
      nextRevision:2,expiresAt:EXPIRY
    });
    assert.equal(newer.kid,'new_2026');
    assert.equal(newer.revision,2);
    assert.notEqual(newer.ciphertext,sealed.ciphertext);
    assert.deepEqual(rotated.open(args(newer,OWNER,2)),GMAIL);
    const newOnly=codec('new_2026',new Map([['new_2026',keys.get('new_2026')]]));
    mustReject(()=>newOnly.open(args(sealed)));
    assert.deepEqual(newOnly.open(args(newer,OWNER,2)),GMAIL);
    old.destroy();rotated.destroy();newOnly.destroy();
  });
  it('opens a validated IMAP app-password envelope without interpreting it as OAuth',()=>{
    const vault=codec();
    const sealed=vault.seal({binding:imapBinding,credential:IMAP,revision:7,expiresAt:EXPIRY});
    assert.deepEqual(vault.open(args(sealed,imapBinding,7)),IMAP);
    mustReject(()=>vault.open(args(sealed,OWNER,7)));
    mustReject(()=>vault.seal({binding:imapBinding,credential:GMAIL,revision:1,expiresAt:EXPIRY}));
    mustReject(()=>vault.seal({binding:OWNER,credential:IMAP,revision:1,expiresAt:EXPIRY}));
    vault.destroy();
  });
  it('rejects expired envelopes and attempts to seal past or extreme expiries',()=>{
    const vault=codec();
    const sealed=vault.seal({binding:OWNER,credential:GMAIL,revision:1,expiresAt:EXPIRY});
    const future=codec('old_2026',new Map([['old_2026',KEYS().get('old_2026')]]),NOW+7_200_000);
    mustReject(()=>future.open(args(sealed)));
    mustReject(()=>vault.seal({binding:OWNER,credential:GMAIL,revision:1,
      expiresAt:new Date(NOW-1).toISOString()}));
    mustReject(()=>vault.seal({binding:OWNER,credential:GMAIL,revision:1,
      expiresAt:new Date(NOW+367*24*60*60_000).toISOString()}));
    mustReject(()=>vault.seal({binding:OWNER,credential:GMAIL,revision:1,
      expiresAt:'2026-11-06T20:00:00Z'}));
    vault.destroy();future.destroy();
  });
  it('rejects malformed and untrusted credential content',()=>{
    const vault=codec();
    const bad=[
      {...GMAIL,kind:'imap'},
      {...GMAIL,accessToken:''},
      {...GMAIL,refreshToken:''},
      {...GMAIL,accessExpiresAt:'not-a-date'},
      {...GMAIL,accessToken:'x'.repeat(8193)},
      {...GMAIL,extraSecret:'would-leak'},
      {kind:'oauth',refreshToken:'only'},
      {kind:'oauth',accessToken:'x',accessExpiresAt:EXPIRY,refreshToken:null},
      {kind:'imap',username:'x',appPassword:'y'}
    ];
    for(const credential of bad)mustReject(()=>vault.seal({
      binding:OWNER,credential,revision:1,expiresAt:EXPIRY
    }));
    vault.destroy();
  });
  it('rejects malformed owner/provider metadata and unknown fields',()=>{
    const vault=codec();
    const bad=[
      null,{...OWNER,owner:{...OWNER.owner,subject:''}},
      {...OWNER,mailbox:{...OWNER.mailbox,provider:'smtp'}},
      {...OWNER,mailbox:{...OWNER.mailbox,accountId:''}},
      {...OWNER,owner:{...OWNER.owner,verified:true}},
      {...OWNER,unauthorizedGrant:true},
      {...OWNER,mailbox:{...OWNER.mailbox,provider:'gmail',credential:'x'}}
    ];
    for(const binding of bad)mustReject(()=>vault.seal({binding,credential:GMAIL,revision:1,expiresAt:EXPIRY}));
    vault.destroy();
  });
  it('requires explicit 256-bit supplied keys, not passwords or auto-loading secrets',()=>{
    assert.throws(()=>createCredentialEnvelopeCodec(),TypeError);
    assert.throws(()=>createCredentialEnvelopeCodec({keys:new Map([['x',Buffer.from('weak')]]),activeKeyId:'x'}),TypeError);
    assert.throws(()=>createCredentialEnvelopeCodec({keys:KEYS(),activeKeyId:'missing'}),TypeError);
    assert.throws(()=>createCredentialEnvelopeCodec({keys:KEYS(),activeKeyId:'../../bad'}),TypeError);
    assert.throws(()=>createCredentialEnvelopeCodec({keys:{old_2026:randomBytes(32)},activeKeyId:'old_2026'}),TypeError);
  });
  it('never accepts an unknown key ID, revision zero, or duplicate metadata',()=>{
    const vault=codec();
    const sealed=vault.seal({binding:OWNER,credential:GMAIL,revision:1,expiresAt:EXPIRY});
    mustReject(()=>vault.open(args({...sealed,kid:'unknown'})));
    mustReject(()=>vault.open(args(sealed,OWNER,0)));
    mustReject(()=>vault.seal({binding:OWNER,credential:GMAIL,revision:0,expiresAt:EXPIRY}));
    mustReject(()=>vault.seal({binding:OWNER,credential:GMAIL,revision:Number.MAX_SAFE_INTEGER+1,expiresAt:EXPIRY}));
    vault.destroy();
  });
  it('zeroes private key copies on destruction and refuses any further operations',()=>{
    const keys=KEYS();
    const vault=codec('old_2026',keys);
    const sealed=vault.seal({binding:OWNER,credential:GMAIL,revision:1,expiresAt:EXPIRY});
    vault.destroy();
    vault.destroy();
    assert.equal(keys.get('old_2026').length,32);
    assert.ok(keys.get('old_2026').some(byte=>byte!==0),'Must not wipe caller-owned key bytes');
    mustReject(()=>vault.open(args(sealed)));
    mustReject(()=>vault.seal({binding:OWNER,credential:GMAIL,revision:2,expiresAt:EXPIRY}));
  });
});
