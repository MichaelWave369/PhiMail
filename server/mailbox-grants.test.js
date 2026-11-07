import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {createMailboxGrantAuthority,MailboxGrantDenied,
  MAILBOX_GRANT_SCHEMA,MAILBOX_INTENT_SCHEMA} from './mailbox-grants.js';

const START=Date.parse('2026-11-06T19:00:00.000Z');
const SESS_A='identity-session-aaaaaaaaaaaaaaaaaaaaaaaaa';
const SESS_B='identity-session-bbbbbbbbbbbbbbbbbbbbbbbbb';
const GMAIL_A='gmail-session-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const GMAIL_B='gmail-session-bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OUTLOOK='outlook-session-ccccccccccccccccccccccccc';
const IMAP='imap-session-ddddddddddddddddddddddddddd';
const SCOPES=['read:inbox','read:message'];

function makeHarness({maxPending=64,maxGrants=128}={}){
  const clock={ms:START};
  const identities=new Map([
    ['identityA',{issuer:'http://127.0.0.1:8080/realms/phiid-dev',
      subject:'person-1',sessionKey:SESS_A,expiresAt:START+20*60_000}],
    ['identityA2',{issuer:'http://127.0.0.1:8080/realms/phiid-dev',
      subject:'person-1',sessionKey:SESS_B,expiresAt:START+20*60_000}],
    ['identityOther',{issuer:'http://127.0.0.1:8080/realms/phiid-dev',
      subject:'person-2',sessionKey:'identity-session-ccccccccccccccccccccccccc',expiresAt:START+20*60_000}],
    ['identityOtherIssuer',{issuer:'https://different-issuer.example',
      subject:'person-1',sessionKey:SESS_A,expiresAt:START+20*60_000}]
  ]);
  const mailboxes=new Map([
    ['gmailA',{provider:'gmail',accountId:'google-stable-account-A',sessionKey:GMAIL_A,
      expiresAt:START+20*60_000}],
    ['gmailReconnected',{provider:'gmail',accountId:'google-stable-account-A',sessionKey:GMAIL_B,
      expiresAt:START+20*60_000}],
    ['gmailOther',{provider:'gmail',accountId:'google-stable-account-B',sessionKey:GMAIL_B,
      expiresAt:START+20*60_000}],
    ['outlook',{provider:'outlook',accountId:'graph-stable-object-99',sessionKey:OUTLOOK,
      expiresAt:START+30*60_000}],
    ['imap',{provider:'imap',accountId:'imap-server-and-account',sessionKey:IMAP,
      expiresAt:START+10*60_000}]
  ]);
  const approvals=new Map();
  const hooks={approvalWait:null,mailboxWait:null};
  let calls={identity:0,mailbox:0,approval:0};
  const authority=createMailboxGrantAuthority({
    now:()=>clock.ms,maxPending,maxGrants,
    verifyIdentity:async evidence=>{
      calls.identity++;
      if(typeof evidence!=='string'||!identities.has(evidence))
        throw new MailboxGrantDenied();
      return identities.get(evidence);
    },
    verifyMailbox:async evidence=>{
      calls.mailbox++;
      if(hooks.mailboxWait)await hooks.mailboxWait();
      if(typeof evidence!=='string'||!mailboxes.has(evidence))
        throw new MailboxGrantDenied();
      return mailboxes.get(evidence);
    },
    verifyApproval:async evidence=>{
      calls.approval++;
      if(hooks.approvalWait)await hooks.approvalWait();
      if(typeof evidence!=='string'||!approvals.has(evidence))
        throw new MailboxGrantDenied();
      return approvals.get(evidence);
    }
  });
  let serial=0;
  function proof(intent,{identity='identityA',mailbox='gmailA',override={}}={}){
    const owner=identities.get(identity),account=mailboxes.get(mailbox);
    const evidence='server-attested-approval-'+String(++serial).padStart(3,'0');
    approvals.set(evidence,{
      intentId:intent.intentId,challenge:intent.challenge,
      issuer:owner.issuer,subject:owner.subject,
      identitySessionKey:owner.sessionKey,
      provider:account.provider,accountId:account.accountId,
      mailboxSessionKey:account.sessionKey,capabilities:[...intent.capabilities],
      approvedAt:clock.ms,...override
    });
    return evidence;
  }
  async function grant({identity='identityA',mailbox='gmailA',capabilities=SCOPES}={}){
    const intent=await authority.begin({
      identityEvidence:identity,mailboxEvidence:mailbox,
      requestedCapabilities:capabilities
    });
    const receipt=await authority.approve({
      intentId:intent.intentId,approvalEvidence:proof(intent,{identity,mailbox})
    });
    return {intent,receipt};
  }
  return {authority,clock,identities,mailboxes,approvals,hooks,grant,proof,calls};
}
async function denied(task){
  await assert.rejects(task,error=>error instanceof MailboxGrantDenied);
}
function authorize(authority,grantId,{
  identityEvidence='identityA',mailboxEvidence='gmailA',
  capability='read:inbox'
}={}){
  return authority.authorize({grantId,identityEvidence,mailboxEvidence,capability});
}

describe('R11 trusted owner-to-mailbox contract',()=>{
  it('requires all three independently supplied trusted verifier functions',()=>{
    assert.throws(()=>createMailboxGrantAuthority(),TypeError);
    assert.throws(()=>createMailboxGrantAuthority({
      verifyIdentity:()=>{},verifyMailbox:()=>{}
    }),TypeError);
    assert.throws(()=>createMailboxGrantAuthority({
      verifyIdentity:()=>{},verifyMailbox:()=>{},verifyApproval:()=>{},maxPending:0
    }),TypeError);
  });
  it('allows narrow read-only operations ONLY after explicit independently verified approval',async()=>{
    const h=makeHarness();
    const intent=await h.authority.begin({
      identityEvidence:'identityA',mailboxEvidence:'gmailA',
      requestedCapabilities:SCOPES
    });
    assert.equal(intent.schema,MAILBOX_INTENT_SCHEMA);
    assert.equal(intent.mailbox.provider,'gmail');
    assert.deepEqual(intent.capabilities,SCOPES);
    assert.match(intent.challenge,/^[A-Za-z0-9_-]{20,128}$/);
    await denied(()=>authorize(h.authority,intent.intentId));
    const receipt=await h.authority.approve({
      intentId:intent.intentId,approvalEvidence:h.proof(intent)
    });
    assert.equal(receipt.schema,MAILBOX_GRANT_SCHEMA);
    assert.equal(receipt.token_or_credentials_included,false);
    assert.equal(receipt.phiid_login_alone_grants_access,false);
    assert.ok(!JSON.stringify(receipt).includes('oauth-access-token'));
    const allowed=await authorize(h.authority,receipt.grantId);
    assert.equal(allowed.authorized,true);
    assert.equal(allowed.capability,'read:inbox');
    assert.deepEqual(allowed.owner,{
      issuer:'http://127.0.0.1:8080/realms/phiid-dev',subject:'person-1'
    });
    assert.deepEqual(allowed.mailbox,{provider:'gmail',accountId:'google-stable-account-A'});
    const read=await authorize(h.authority,receipt.grantId,{capability:'read:message'});
    assert.equal(read.authorized,true);
    await denied(()=>authorize(h.authority,receipt.grantId,{capability:'write:message'}));
    await denied(()=>authorize(h.authority,receipt.grantId,{capability:'delete'}));
  });
  it('PhiID alone, mailbox alone, R3 review receipt, and forged browser claims never authorize',async()=>{
    const h=makeHarness();
    await denied(()=>h.authority.begin({
      identityEvidence:undefined,mailboxEvidence:'gmailA',requestedCapabilities:SCOPES
    }));
    await denied(()=>h.authority.begin({
      identityEvidence:'identityA',mailboxEvidence:undefined,requestedCapabilities:SCOPES
    }));
    await denied(()=>h.authority.begin({
      identityEvidence:{profile:{sub:'person-1',authenticated:true}},
      mailboxEvidence:'gmailA',requestedCapabilities:SCOPES
    }));
    await denied(()=>h.authority.begin({
      identityEvidence:'identityA',mailboxEvidence:{
        provider:'gmail',email:'gmail-owner@example.test'
      },requestedCapabilities:SCOPES
    }));
    const intent=await h.authority.begin({
      identityEvidence:'identityA',mailboxEvidence:'gmailA',requestedCapabilities:SCOPES
    });
    await denied(()=>h.authority.approve({
      intentId:intent.intentId,
      approvalEvidence:{schema:'phimail.local-mailbox-review/0.1',acknowledged:true}
    }));
    await denied(()=>h.authority.approve({
      intentId:intent.intentId,approvalEvidence:'server-attested-anything'
    }));
  });
  it('one-time approval is consumed before async verifier; replay and concurrent approvals fail',async()=>{
    const h=makeHarness();
    const intent=await h.authority.begin({
      identityEvidence:'identityA',mailboxEvidence:'gmailA',requestedCapabilities:SCOPES
    });
    let release,start;
    const entered=new Promise(resolve=>start=resolve);
    const gate=new Promise(resolve=>release=resolve);
    h.hooks.approvalWait=async()=>{start();await gate;};
    const evidence=h.proof(intent);
    const first=h.authority.approve({intentId:intent.intentId,approvalEvidence:evidence});
    await entered;
    await denied(()=>h.authority.approve({intentId:intent.intentId,approvalEvidence:evidence}));
    release();
    const accepted=await first;
    assert.equal(accepted.schema,MAILBOX_GRANT_SCHEMA);
    await denied(()=>h.authority.approve({intentId:intent.intentId,approvalEvidence:evidence}));
    assert.equal(h.calls.approval,1);
  });
  it('rejects an approval for a different nonce, principal, mailbox session, or scope',async()=>{
    const changes=[
      {challenge:'replayed-challenge'},
      {subject:'somebody-else'},
      {identitySessionKey:SESS_B},
      {accountId:'account-substitution'},
      {mailboxSessionKey:GMAIL_B},
      {provider:'outlook'},
      {issuer:'https://false-issuer.example'},
      {capabilities:['read:message']},
      {approvedAt:START-10},
    ];
    for(const override of changes){
      const h=makeHarness();
      const intent=await h.authority.begin({
        identityEvidence:'identityA',mailboxEvidence:'gmailA',requestedCapabilities:SCOPES
      });
      await denied(()=>h.authority.approve({
        intentId:intent.intentId,
        approvalEvidence:h.proof(intent,{override})
      }));
      await denied(()=>authorize(h.authority,intent.intentId));
    }
  });
  it('scopes authority to exact original identity and provider account sessions',async()=>{
    const h=makeHarness();
    const {receipt}=await h.grant();
    const id=receipt.grantId;
    const invalid=[
      {identityEvidence:'identityA2'},
      {identityEvidence:'identityOther'},
      {identityEvidence:'identityOtherIssuer'},
      {mailboxEvidence:'gmailReconnected'},
      {mailboxEvidence:'gmailOther'},
      {mailboxEvidence:'outlook'},
      {mailboxEvidence:'imap'}
    ];
    for(const context of invalid)await denied(()=>authorize(h.authority,id,context));
    assert.equal((await authorize(h.authority,id)).authorized,true);
    const {receipt:outlook}=await h.grant({mailbox:'outlook',capabilities:['read:message']});
    assert.equal((await authorize(h.authority,outlook.grantId,{
      mailboxEvidence:'outlook',capability:'read:message'
    })).authorized,true);
    await denied(()=>authorize(h.authority,outlook.grantId,{
      mailboxEvidence:'gmailA',capability:'read:message'
    }));
    await denied(()=>authorize(h.authority,outlook.grantId,{
      mailboxEvidence:'outlook',capability:'read:inbox'
    }));
  });
  it('owner can revoke after reauth but other owners cannot revoke or read grant',async()=>{
    const h=makeHarness();
    const {receipt}=await h.grant();
    const id=receipt.grantId;
    await denied(()=>h.authority.revoke({
      grantId:id,identityEvidence:'identityOther'
    }));
    await denied(()=>h.authority.revoke({
      grantId:id,identityEvidence:'identityOtherIssuer'
    }));
    const revoked=await h.authority.revoke({
      grantId:id,identityEvidence:'identityA2'
    });
    assert.equal(revoked.revoked,true);
    assert.equal(revoked.remote_provider_token_revoked,false);
    assert.equal(revoked.vault_record_deleted,false);
    await denied(()=>authorize(h.authority,id));
    await denied(()=>h.authority.revoke({grantId:id,identityEvidence:'identityA'}));
  });
  it('bulk revocation is owner-specific even if sessions use the same mailbox provider',async()=>{
    const h=makeHarness();
    const a=await h.grant();
    const b=await h.grant({mailbox:'outlook'});
    const c=await h.grant({identity:'identityOther',mailbox:'gmailOther'});
    const removed=await h.authority.revokeAll({identityEvidence:'identityA2'});
    assert.equal(removed.revoked_grants,2);
    assert.equal(removed.vault_records_deleted,false);
    await denied(()=>authorize(h.authority,a.receipt.grantId));
    await denied(()=>authorize(h.authority,b.receipt.grantId,{mailboxEvidence:'outlook'}));
    const unaffected=await authorize(h.authority,c.receipt.grantId,{
      identityEvidence:'identityOther',mailboxEvidence:'gmailOther'
    });
    assert.equal(unaffected.authorized,true);
  });
  it('revocation while verifying provider prevents an in-flight authorization result',async()=>{
    const h=makeHarness();
    const {receipt}=await h.grant();
    let begin,release;
    const started=new Promise(resolve=>begin=resolve);
    const held=new Promise(resolve=>release=resolve);
    h.hooks.mailboxWait=async()=>{begin();await held;};
    const pending=authorize(h.authority,receipt.grantId);
    await started;
    await h.authority.revoke({grantId:receipt.grantId,identityEvidence:'identityA'});
    release();
    await denied(()=>pending);
  });
  it('intent and grant expiry fail closed, including expiry during slow verification',async()=>{
    const h=makeHarness();
    const intent=await h.authority.begin({
      identityEvidence:'identityA',mailboxEvidence:'gmailA',requestedCapabilities:SCOPES
    });
    h.clock.ms+=5*60_000+1;
    await denied(()=>h.authority.approve({
      intentId:intent.intentId,approvalEvidence:h.proof(intent)
    }));
    const {receipt}=await h.grant();
    h.clock.ms=START+20*60_000+1;
    await denied(()=>authorize(h.authority,receipt.grantId));
  });
  it('grant expiry never extends either identity or mailbox session or 15 minutes',async()=>{
    const h=makeHarness();
    h.mailboxes.set('gmailA',{...h.mailboxes.get('gmailA'),expiresAt:START+2*60_000});
    const {receipt}=await h.grant();
    assert.equal(receipt.expiresAt,new Date(START+2*60_000).toISOString());
    h.clock.ms=START+2*60_000+1;
    await denied(()=>authorize(h.authority,receipt.grantId));
  });
  it('rejects unknown scopes, repeated scopes, unlimited requests and malformed verifier output',async()=>{
    const h=makeHarness({maxPending:1,maxGrants:1});
    for(const scopes of [
      ['read:inbox','read:inbox'],['send:message'],[],
      ['read:inbox','write:message'],['read:inbox','read:message','send:message']
    ]){
      await denied(()=>h.authority.begin({
        identityEvidence:'identityA',mailboxEvidence:'gmailA',
        requestedCapabilities:scopes
      }));
    }
    const intent=await h.authority.begin({
      identityEvidence:'identityA',mailboxEvidence:'gmailA',
      requestedCapabilities:SCOPES
    });
    await denied(()=>h.authority.begin({
      identityEvidence:'identityA',mailboxEvidence:'gmailA',
      requestedCapabilities:SCOPES
    }));
    const receipt=await h.authority.approve({
      intentId:intent.intentId,approvalEvidence:h.proof(intent)
    });
    const another=await h.authority.begin({
      identityEvidence:'identityA',mailboxEvidence:'gmailA',
      requestedCapabilities:SCOPES
    });
    await denied(()=>h.authority.approve({
      intentId:another.intentId,approvalEvidence:h.proof(another)
    }));
    assert.equal((await authorize(h.authority,receipt.grantId)).authorized,true);
  });
  it('destroy removes pending and grants, preventing any further authorization',async()=>{
    const h=makeHarness();
    const {receipt}=await h.grant();
    h.authority.destroy();
    h.authority.destroy();
    await denied(()=>authorize(h.authority,receipt.grantId));
    await denied(()=>h.authority.revokeAll({identityEvidence:'identityA'}));
    await denied(()=>h.authority.begin({
      identityEvidence:'identityA',mailboxEvidence:'gmailA',
      requestedCapabilities:SCOPES
    }));
  });
});
