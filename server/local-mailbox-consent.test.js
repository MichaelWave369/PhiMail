import {afterEach,describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {request as rawHttp} from 'node:http';
import {createBridge} from './bridge.js';
import {DEV_ORIGIN,DEV_ISSUER,DEV_CLIENT_ID} from './phiid-lab.js';
import {LOCAL_CONSENT_SCHEMA} from './local-mailbox-consent.js';

const MS_ID='12345678-1234-4234-8234-123456789012';
const ENV={
  BRIDGE_PUBLIC_ORIGIN:DEV_ORIGIN,
  PHIMAIL_LOCAL_PHIID:'1',
  MICROSOFT_CLIENT_ID:MS_ID,
  MICROSOFT_CLIENT_SECRET:'synthetic-local-test-secret'
};
const servers=[];
afterEach(async()=>{
  for(const server of servers.splice(0))await new Promise(done=>server.close(done));
});
function request(base,path,{method='GET',cookie='',headers={},body=null}={}){
  return new Promise((resolve,reject)=>{
    const payload=body===null?null:Buffer.from(JSON.stringify(body));
    const req=rawHttp(base+path,{method,headers:{
      Host:'127.0.0.1:5173',
      ...(cookie?{Cookie:cookie}:{}),
      ...(payload?{'Content-Type':'application/json',
        'Content-Length':String(payload.length)}:{}),
      ...headers
    }},res=>{
      const chunks=[];
      res.on('data',chunk=>chunks.push(chunk));
      res.on('error',reject);
      res.on('end',()=>{
        const text=Buffer.concat(chunks).toString('utf8');
        resolve({status:res.statusCode,
          data:text.startsWith('{')?JSON.parse(text):null,
          raw:text,location:res.headers.location,
          cookies:res.headers['set-cookie']||[]
        });
      });
    });
    req.on('error',reject);req.end(payload||undefined);
  });
}
function takeCookie(response,name){
  const val=response.cookies.find(x=>x.startsWith(name+'=')&&!x.startsWith(name+'=;'));
  assert.ok(val,'Missing expected cookie '+name);
  return val.split(';')[0];
}
function fakePhiID(subject='verified-local-owner'){
  return {
    async authorization(flow){
      const url=new URL(DEV_ISSUER+'/protocol/openid-connect/auth');
      url.searchParams.set('state',flow.state);
      return url.href;
    },
    async exchange(_url,flow){
      return {iss:DEV_ISSUER,aud:DEV_CLIENT_ID,sub:subject,
        exp:Math.floor(Date.now()/1000)+600,
        nonce:flow.nonce,preferred_username:'test-owner'};
    }
  };
}
function fakeProvider(state){
  return async (url,options={})=>{
    const u=String(url);
    if(u==='https://login.microsoftonline.com/consumers/oauth2/v2.0/token'){
      return new Response(JSON.stringify({
        token_type:'Bearer',access_token:'secret-access-do-not-reflect',
        refresh_token:'secret-refresh-do-not-reflect',
        expires_in:3600,scope:'User.Read Mail.Read offline_access'
      }),{status:200});
    }
    if(u==='https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName'){
      state.graphReads+=1;
      if(state.graphWait)await state.graphWait(state.graphReads);
      return new Response(JSON.stringify({
        id:state.graphId,mail:'verified-outlook@example.test',
        userPrincipalName:'verified-outlook@example.test'
      }),{status:200});
    }
    if(u.includes('graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?')){
      return new Response(JSON.stringify({value:[]}),{status:200});
    }
    throw new Error('Unexpected external URL: '+u);
  };
}
async function setup({env={},subject='verified-local-owner'}={}){
  const state={graphId:'graph-owned-id-001',graphReads:0,graphWait:null};
  const bridge=createBridge({
    env:{...ENV,...env},
    fetchImpl:fakeProvider(state),
    identityProvider:fakePhiID(subject)
  });
  await new Promise(ok=>bridge.listen(0,'127.0.0.1',ok));
  servers.push(bridge);
  return {base:'http://127.0.0.1:'+bridge.address().port,state};
}
async function signInPhiID(base){
  const start=await request(base,'/auth/phiid/start');
  assert.equal(start.status,302);
  const state=new URL(start.location).searchParams.get('state');
  const cb=await request(base,'/auth/phiid/callback?code=local-test-code&state='+state,{
    cookie:takeCookie(start,'pm_oidc_flow')
  });
  assert.equal(cb.status,302);
  return takeCookie(cb,'pm_identity');
}
async function signInOutlook(base){
  const start=await request(base,'/auth/microsoft/start');
  assert.equal(start.status,302);
  const state=new URL(start.location).searchParams.get('state');
  const cb=await request(base,'/auth/microsoft/callback?code=local-test-code&state='+state,{
    cookie:takeCookie(start,'pm_ms_flow')
  });
  assert.equal(cb.status,302);
  return takeCookie(cb,'pm_ms_session');
}
const root='/api/identity/mailbox-consent';
const beginBody=()=>({schema:LOCAL_CONSENT_SCHEMA,provider:'outlook',
  capabilities:['read:inbox','read:message']});
function action(base,name,cookie,body,extra={}){
  const route=name==='begin-mailbox-consent'?'intent':
    name==='approve-mailbox-consent'?'approve':'revoke';
  return request(base,root+'/'+route,{
    method:'POST',cookie,body,
    headers:{Origin:DEV_ORIGIN,'X-PhiMail-Action':name,...extra}
  });
}
async function begin(base,cookie){
  const r=await action(base,'begin-mailbox-consent',cookie,beginBody());
  assert.equal(r.status,201);
  return r.data.intent;
}
function acknowledgement(intent){
  return {schema:LOCAL_CONSENT_SCHEMA,intentId:intent.id,
    challenge:intent.challenge,acknowledged:true};
}

describe('R13 explicit, temporary local Outlook consent',()=>{
  it('is disabled when PhiID lab is off, Outlook missing or production enabled',async()=>{
    const identityOff=await setup({env:{PHIMAIL_LOCAL_PHIID:'0'}});
    assert.equal((await request(identityOff.base,root)).status,503);
    const outlookOff=await setup({env:{MICROSOFT_CLIENT_SECRET:''}});
    assert.equal((await request(outlookOff.base,root)).status,503);
    const prod=await setup({env:{NODE_ENV:'production',
      PHIMAIL_ENABLE_EXPERIMENTAL_BRIDGE:'1'}});
    assert.equal((await request(prod.base,root)).status,503);
  });
  it('requires two independent sessions and exposes no credentials or extra mailbox authority',async()=>{
    const {base}=await setup();
    const empty=await request(base,root);
    assert.equal(empty.status,200);
    assert.equal(empty.data.identity_verified,false);
    assert.equal(empty.data.outlook_verified,false);
    assert.equal(empty.data.eligible_to_request_consent,false);
    assert.equal(empty.data.live_mailbox_reads_use_this_grant,false);
    const phi=await signInPhiID(base);
    const phiOnly=await request(base,root,{cookie:phi});
    assert.equal(phiOnly.data.identity_verified,true);
    assert.equal(phiOnly.data.outlook_verified,false);
    assert.equal((await action(base,'begin-mailbox-consent',phi,beginBody())).status,403);
    const outlook=await signInOutlook(base);
    const outlookOnly=await request(base,root,{cookie:outlook});
    assert.equal(outlookOnly.data.identity_verified,false);
    assert.equal(outlookOnly.data.outlook_verified,true);
    assert.equal((await action(base,'begin-mailbox-consent',outlook,beginBody())).status,403);
    const both=phi+'; '+outlook;
    const state=await request(base,root,{cookie:both});
    assert.equal(state.data.identity_verified,true);
    assert.equal(state.data.outlook_verified,true);
    assert.equal(state.data.eligible_to_request_consent,true);
    assert.equal(state.data.mailbox.accountId,'microsoft-consumers:graph-owned-id-001');
    assert.equal(state.data.grant,null);
    assert.ok(!state.raw.includes('secret-access-do-not-reflect'));
    assert.ok(!state.raw.includes('secret-refresh-do-not-reflect'));
    assert.equal((await request(base,'/api/mail/messages?provider=outlook',{cookie:phi})).status,401);
  });
  it('requires exact explicit approval, records a temporary grant, and permits immediate revoke',async()=>{
    const {base}=await setup();
    const phi=await signInPhiID(base),ms=await signInOutlook(base),both=phi+'; '+ms;
    const intent=await begin(base,both);
    assert.match(intent.id,/^[A-Za-z0-9_-]{20,128}$/);
    assert.match(intent.challenge,/^[A-Za-z0-9_-]{20,128}$/);
    assert.deepEqual(intent.capabilities,['read:inbox','read:message']);
    assert.equal(intent.mailbox.accountId,'microsoft-consumers:graph-owned-id-001');
    const approved=await action(base,'approve-mailbox-consent',both,acknowledgement(intent));
    assert.equal(approved.status,201);
    assert.equal(approved.data.grant.status,'local_ephemeral_grant_only');
    assert.equal(approved.data.live_mailbox_reads_use_this_grant,false);
    assert.equal(approved.data.credentials_persisted,false);
    assert.equal(approved.data.account_linked_persistently,false);
    assert.ok(!approved.raw.includes('secret-access-do-not-reflect'));
    const active=await request(base,root,{cookie:both});
    assert.equal(active.data.grant.status,'local_ephemeral_grant_only');
    assert.ok(Date.parse(active.data.grant.expires_at)>Date.now());
    assert.equal((await action(base,'approve-mailbox-consent',both,
      acknowledgement(intent))).status,403);
    const removed=await action(base,'revoke-mailbox-consent',phi,{
      schema:LOCAL_CONSENT_SCHEMA
    });
    assert.equal(removed.status,200);
    assert.equal(removed.data.revoked_grants,1);
    assert.equal(removed.data.remote_oauth_tokens_revoked,false);
    const cleared=await request(base,root,{cookie:both});
    assert.equal(cleared.data.grant,null);
    // Separate Microsoft OAuth still works after revoking a grant receipt.
    assert.equal((await request(base,'/api/mail/messages?provider=outlook',
      {cookie:ms})).status,200);
  });
  it('denies wrong challenge and burns the one-time intent',async()=>{
    const {base}=await setup();
    const both=(await signInPhiID(base))+'; '+(await signInOutlook(base));
    const intent=await begin(base,both);
    const bad={...acknowledgement(intent),challenge:'A'.repeat(43)}; // well formed, wrong proof
    assert.equal((await action(base,'approve-mailbox-consent',both,bad)).status,403);
    assert.equal((await action(base,'approve-mailbox-consent',both,
      acknowledgement(intent))).status,403);
    const state=await request(base,root,{cookie:both});
    assert.equal(state.data.grant,null);
  });
  it('rejects forged body, provider, authority, origin, Host, cookies and action headers',async()=>{
    const {base}=await setup();
    const both=(await signInPhiID(base))+'; '+(await signInOutlook(base));
    const badPayloads=[
      {...beginBody(),provider:'gmail'},
      {...beginBody(),provider:'imap'},
      {...beginBody(),capabilities:['send:mail']},
      {...beginBody(),capabilities:['read:message','read:inbox']},
      {...beginBody(),issuer:DEV_ISSUER},
      {...beginBody(),authenticated:true},
      {...beginBody(),capabilities:['read:inbox']},
      {...beginBody(),schema:'phimail.local-mailbox-review/0.1'}
    ];
    for(const data of badPayloads)
      assert.equal((await action(base,'begin-mailbox-consent',both,data)).status,403);
    const forgedOrigin=await action(base,'begin-mailbox-consent',both,beginBody(),
      {Origin:'https://evil.example'});
    assert.equal(forgedOrigin.status,403);
    const forgedHost=await action(base,'begin-mailbox-consent',both,beginBody(),
      {Host:'evil.example'});
    assert.equal(forgedHost.status,403);
    const site=await action(base,'begin-mailbox-consent',both,beginBody(),
      {'Sec-Fetch-Site':'cross-site'});
    assert.equal(site.status,403);
    const missingAction=await action(base,'begin-mailbox-consent',both,beginBody(),
      {'X-PhiMail-Action':'do-anything'});
    assert.equal(missingAction.status,403);
    const wrongMethod=await request(base,root+'/intent',{cookie:both});
    assert.equal(wrongMethod.status,405);
    const badQuery=await request(base,root+'?provider=gmail',{cookie:both});
    assert.equal(badQuery.status,400);
    const dups=await request(base,root,{
      cookie:both+'; '+both.split('; ')[1]
    });
    assert.equal(dups.status,200);
    assert.equal(dups.data.outlook_verified,false);
  });
  it('cannot approve under a different identity or provider session after reconnect',async()=>{
    const {base}=await setup();
    const firstPhi=await signInPhiID(base),firstOutlook=await signInOutlook(base);
    const initial=firstPhi+'; '+firstOutlook;
    const intent=await begin(base,initial);
    const secondPhi=await signInPhiID(base);
    const identitySwapped=await action(base,'approve-mailbox-consent',
      secondPhi+'; '+firstOutlook,acknowledgement(intent));
    assert.equal(identitySwapped.status,403);
    const intent2=await begin(base,initial);
    const secondOutlook=await signInOutlook(base);
    const mailboxSwapped=await action(base,'approve-mailbox-consent',
      firstPhi+'; '+secondOutlook,acknowledgement(intent2));
    assert.equal(mailboxSwapped.status,403);
  });
  it('denies approval when fresh Graph account no longer matches OAuth proof',async()=>{
    const {base,state}=await setup();
    const both=(await signInPhiID(base))+'; '+(await signInOutlook(base));
    const intent=await begin(base,both);
    state.graphId='account-swap-attempt';
    assert.equal((await action(base,'approve-mailbox-consent',
      both,acknowledgement(intent))).status,403);
    assert.equal((await request(base,root,{cookie:both})).data.grant,null);
  });
  it('does not issue two grants for concurrent replay of the same approval',async()=>{
    const {base}=await setup();
    const both=(await signInPhiID(base))+'; '+(await signInOutlook(base));
    const intent=await begin(base,both),body=acknowledgement(intent);
    const all=await Promise.all([
      action(base,'approve-mailbox-consent',both,body),
      action(base,'approve-mailbox-consent',both,body)
    ]);
    assert.deepEqual(all.map(x=>x.status).sort((a,b)=>a-b),[201,403]);
    assert.equal((await request(base,root,{cookie:both})).data.grant.status,
      'local_ephemeral_grant_only');
  });
  it('rechecks session revocation during approval and refuses a completed-looking grant',async()=>{
    const {base,state}=await setup();
    const phi=await signInPhiID(base),ms=await signInOutlook(base);
    const both=phi+'; '+ms;
    const intent=await begin(base,both);
    let start,release;
    const entered=new Promise(resolve=>start=resolve);
    const held=new Promise(resolve=>release=resolve);
    const currentReads=state.graphReads;
    state.graphWait=async count=>{
      if(count===currentReads+1){start();await held;}
    };
    const approval=action(base,'approve-mailbox-consent',both,acknowledgement(intent));
    await entered;
    const disconnected=await action(base,'revoke-mailbox-consent',phi,{
      schema:LOCAL_CONSENT_SCHEMA
    });
    assert.equal(disconnected.status,200);
    const logout=await request(base,'/api/session/disconnect?provider=outlook',{
      method:'POST',cookie:ms,
      headers:{Origin:DEV_ORIGIN,'X-PhiMail-Action':'disconnect-outlook'}
    });
    assert.equal(logout.status,200);
    release();
    const outcome=await approval;
    assert.equal(outcome.status,403);
    assert.equal((await request(base,root,{cookie:both})).data.grant,null);
  });
});
