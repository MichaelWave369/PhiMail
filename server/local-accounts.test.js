import {afterEach,describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {request as rawHttp} from 'node:http';
import {createBridge} from './bridge.js';
import {localAccountSnapshot,LOCAL_ACCOUNTS_SCHEMA} from './local-accounts.js';

const ORIGIN='http://127.0.0.1:5173';
const ENV={
  BRIDGE_PUBLIC_ORIGIN:ORIGIN,
  GOOGLE_CLIENT_ID:'test-google-client',GOOGLE_CLIENT_SECRET:'test-google-secret',
  MICROSOFT_CLIENT_ID:'12345678-1234-4234-8234-123456789012',
  MICROSOFT_CLIENT_SECRET:'test-ms-secret',
  IMAP_HOST:'mail.example.test',IMAP_PORT:'993',
  IMAP_USERNAME:'imap-owner@example.test',
  IMAP_APP_PASSWORD:'IMAP-SERVER-PRIVATE-PASSWORD',
  IMAP_UNLOCK_KEY:'A-long-random-local-unlock-for-tests-only-0000'
};
const live=[];
afterEach(async()=>{
  for(const server of live.splice(0))await new Promise(resolve=>server.close(resolve));
});
function fakeImap(){
  return {
    mailbox:null,
    async connect(){},
    async getMailboxLock(path,opts){
      assert.equal(path,'INBOX');
      assert.equal(opts.readOnly,true);
      this.mailbox={readOnly:true,exists:0,uidValidity:'1'};
      return {release(){}};
    },
    async logout(){}
  };
}
function providerFake({waitOnGmailRead=null}={}){
  return async url=>{
    const path=String(url);
    let data;
    if(path==='https://oauth2.googleapis.com/token') data={
      access_token:'private-gmail-access',
      refresh_token:'private-gmail-refresh',
      expires_in:3600
    };
    else if(path==='https://gmail.googleapis.com/gmail/v1/users/me/profile'){
      data={emailAddress:'gmail-owner@example.test'};
    }else if(path.includes('/gmail/v1/users/me/messages?')){
      if(waitOnGmailRead)await waitOnGmailRead();
      data={messages:[]};
    }else if(path==='https://login.microsoftonline.com/consumers/oauth2/v2.0/token'){
      data={token_type:'Bearer',access_token:'private-outlook-access',
        refresh_token:'private-outlook-refresh',expires_in:3600,
        scope:'Mail.Read User.Read offline_access'};
    }else if(path==='https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName'){
      data={id:'microsoft-subject',mail:'ms-owner@example.test'};
    }else throw new Error('Unexpected fake network destination '+path);
    return new Response(JSON.stringify(data),{status:200});
  };
}
async function setup({env={},waitOnGmailRead=null}={}){
  const server=createBridge({
    env:{...ENV,...env},
    fetchImpl:providerFake({waitOnGmailRead}),
    imapClientFactory:fakeImap
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  live.push(server);
  return 'http://127.0.0.1:'+server.address().port;
}
function request(base,path,{method='GET',body,headers={},cookie=''}={}){
  return new Promise((resolve,reject)=>{
    const rawBody=body===undefined?undefined:JSON.stringify(body);
    const req=rawHttp(base+path,{method,headers:{
      Host:'127.0.0.1:5173',...(cookie?{Cookie:cookie}:{}),
      ...(rawBody?{'Content-Type':'application/json'}:{}),...headers,
    }},res=>{
      const chunks=[];
      res.on('data',item=>chunks.push(item));
      res.on('error',reject);
      res.on('end',()=>{
        const raw=Buffer.concat(chunks).toString('utf8');
        resolve({
          status:res.statusCode,
          data:raw.startsWith('{')?JSON.parse(raw):null,
          cookies:res.headers['set-cookie']||[],
          raw,location:res.headers.location
        });
      });
    });
    req.on('error',reject);req.end(rawBody);
  });
}
function cookie(response,name){
  const result=response.cookies.find(x=>x.startsWith(name+'=')&&!x.startsWith(name+'=;'));
  assert.ok(result,'expected '+name+' cookie');
  return result.split(';')[0];
}
async function oauth(base,provider){
  const isMs=provider==='outlook';
  const prefix=isMs?'/auth/microsoft':'/auth/google';
  const start=await request(base,prefix+'/start');
  assert.equal(start.status,302);
  const state=new URL(start.location).searchParams.get('state');
  const flow=cookie(start,isMs?'pm_ms_flow':'pm_oauth');
  const response=await request(base,prefix+'/callback?code=one-time&state='+state,{cookie:flow});
  assert.equal(response.status,302);
  return cookie(response,isMs?'pm_ms_session':'pm_session');
}
async function unlock(base){
  const result=await request(base,'/api/imap/connect',{
    method:'POST',
    body:{unlock:ENV.IMAP_UNLOCK_KEY},
    headers:{Origin:ORIGIN,'X-PhiMail-Action':'connect-imap'}
  });
  assert.equal(result.status,200);
  return cookie(result,'pm_imap_session');
}
async function disconnectAll(base,cookies,headers={}){
  return request(base,'/api/accounts/disconnect-all',{
    method:'POST',cookie:cookies,
    headers:{Origin:ORIGIN,'X-PhiMail-Action':'disconnect-all',...headers}
  });
}
describe('R8 verified local mailbox session inventory',()=>{
  it('exposes exact per-provider status without secrets or false account links',async()=>{
    const base=await setup();
    const response=await request(base,'/api/accounts');
    assert.equal(response.status,200);
    assert.equal(response.data.schema,LOCAL_ACCOUNTS_SCHEMA);
    assert.deepEqual(response.data.accounts.map(a=>a.provider),['gmail','outlook','imap']);
    assert.deepEqual(response.data.accounts.map(a=>a.configured),[true,true,true]);
    assert.equal(response.data.connected_count,0);
    assert.ok(response.data.accounts.every(a=>a.email===null&&a.expires_at===null&&a.capabilities.length===0));
    assert.equal(response.data.phiid_identity_linked,false);
    assert.equal(response.data.phicloud_authorized,false);
    assert.equal(response.data.hosted_multiuser_mailbox,false);
    assert.ok(!response.raw.includes(ENV.IMAP_APP_PASSWORD));
    assert.ok(!response.raw.includes(ENV.IMAP_UNLOCK_KEY));
    assert.ok(!response.raw.includes(ENV.MICROSOFT_CLIENT_SECRET));
  });
  it('reports all three independent sessions without merging identities',async()=>{
    const base=await setup();
    const gmail=await oauth(base,'gmail');
    const outlook=await oauth(base,'outlook');
    const imap=await unlock(base);
    const both=gmail+'; '+outlook+'; '+imap;
    const result=await request(base,'/api/accounts',{cookie:both});
    assert.equal(result.status,200);
    assert.equal(result.data.connected_count,3);
    assert.deepEqual(result.data.accounts.map(a=>a.email),
      ['gmail-owner@example.test','ms-owner@example.test','imap-owner@example.test']);
    assert.deepEqual(result.data.accounts.map(a=>a.authorization),
      ['google_oauth','microsoft_oauth','local_unlock']);
    assert.ok(result.data.accounts.every(a=>a.connected&&a.capabilities.length===2&&
      Date.parse(a.expires_at)>Date.now()));
    assert.ok(!result.raw.includes('private-gmail-access'));
    assert.ok(!result.raw.includes('private-outlook-access'));
    assert.equal(result.data.phiid_identity_linked,false);
    // Explicit provider selection is independent, even with all three cookies.
    const gmailState=await request(base,'/api/session?provider=gmail',{cookie:both});
    const outlookState=await request(base,'/api/session?provider=outlook',{cookie:both});
    const imapState=await request(base,'/api/session?provider=imap',{cookie:both});
    assert.equal(gmailState.data.email,'gmail-owner@example.test');
    assert.equal(outlookState.data.email,'ms-owner@example.test');
    assert.equal(imapState.data.email,'imap-owner@example.test');
  });
  it('allows independent disconnect, then clears every current-browser provider session',async()=>{
    const base=await setup();
    const gmail=await oauth(base,'gmail'),outlook=await oauth(base,'outlook'),imap=await unlock(base);
    const all=gmail+'; '+outlook+'; '+imap+'; pm_identity=opaque-phiid-session';
    const gmailOnly=await request(base,'/api/session/disconnect?provider=gmail',{
      method:'POST',cookie:all,headers:{Origin:ORIGIN}
    });
    assert.equal(gmailOnly.status,200);
    const before=await request(base,'/api/accounts',{cookie:all});
    assert.equal(before.data.connected_count,2);
    const reset=await disconnectAll(base,all);
    assert.equal(reset.status,200);
    assert.equal(reset.data.disconnected_local_sessions,2);
    assert.equal(reset.data.connected_count,0);
    assert.equal(reset.data.phiid_signed_out,false);
    assert.equal(reset.data.remote_provider_tokens_revoked,false);
    assert.equal(reset.data.persistent_credentials_created,false);
    assert.ok(reset.cookies.some(c=>c.startsWith('pm_ms_session=;')));
    assert.ok(reset.cookies.some(c=>c.startsWith('pm_imap_session=;')));
    assert.ok(reset.cookies.some(c=>c.startsWith('pm_session=;')));
    assert.ok(!reset.cookies.some(c=>c.startsWith('pm_identity=')));
    const after=await request(base,'/api/accounts',{cookie:all});
    assert.equal(after.data.connected_count,0);
    const repeat=await disconnectAll(base,all);
    assert.equal(repeat.data.disconnected_local_sessions,0);
  });
  it('fails closed on cross-site requests, spoofed action, methods, and wrong Host',async()=>{
    const base=await setup();
    const gmail=await oauth(base,'gmail');
    const noOrigin=await request(base,'/api/accounts/disconnect-all',{method:'POST',cookie:gmail,
      headers:{'X-PhiMail-Action':'disconnect-all'}});
    assert.equal(noOrigin.status,403);
    const wrongHeader=await disconnectAll(base,gmail,{'X-PhiMail-Action':'delete-accounts'});
    assert.equal(wrongHeader.status,403);
    const crossSite=await disconnectAll(base,gmail,{'Sec-Fetch-Site':'cross-site'});
    assert.equal(crossSite.status,403);
    const contentBody=await request(base,'/api/accounts/disconnect-all',{method:'POST',
      cookie:gmail,body:{anything:true},
      headers:{Origin:ORIGIN,'X-PhiMail-Action':'disconnect-all'}});
    assert.equal(contentBody.status,403);
    const wrongHost=await request(base,'/api/accounts',{headers:{Host:'evil.example'}});
    assert.equal(wrongHost.status,403);
    const wrongQuery=await request(base,'/api/accounts?provider=gmail');
    assert.equal(wrongQuery.status,400);
    const wrongMethod=await request(base,'/api/accounts',{method:'DELETE'});
    assert.equal(wrongMethod.status,405);
    const crossSiteGet=await request(base,'/api/accounts',{headers:{'Sec-Fetch-Site':'cross-site'}});
    assert.equal(crossSiteGet.status,403);
    assert.equal((await request(base,'/api/session',{cookie:gmail})).data.connected,true);
  });
  it('stays disabled outside exact loopback development origin',async()=>{
    const alt=await setup({env:{BRIDGE_PUBLIC_ORIGIN:'http://localhost:5173'}});
    const denied=await request(alt,'/api/accounts');
    assert.equal(denied.status,503);
    const deniedMutation=await disconnectAll(alt,'');
    assert.equal(deniedMutation.status,503);
    const prod=await setup({env:{NODE_ENV:'production',PHIMAIL_ENABLE_EXPERIMENTAL_BRIDGE:'1'}});
    assert.equal((await request(prod,'/api/accounts')).status,503);
  });
  it('does not publish an in-flight Gmail result after bulk disconnect',async()=>{
    let entered;
    const began=new Promise(resolve=>{entered=resolve;});
    let release;
    const held=new Promise(resolve=>{release=resolve;});
    const base=await setup({waitOnGmailRead:async()=>{entered();await held;}});
    const gmail=await oauth(base,'gmail');
    const pending=request(base,'/api/mail/messages?provider=gmail&limit=1',{cookie:gmail});
    await began;
    const disconnected=await disconnectAll(base,gmail);
    assert.equal(disconnected.status,200);
    release();
    const response=await pending;
    assert.equal(response.status,401);
    assert.equal(response.data.error,'mailbox_session_revoked');
    assert.equal((await request(base,'/api/accounts',{cookie:gmail})).data.connected_count,0);
  });
});
describe('R8 local inventory pure contract',()=>{
 it('never trusts a mismatched session provider or expired local session',()=>{
  const fake=[
    {id:'gmail',name:'Gmail',ready:true},
    {id:'outlook',name:'Outlook',ready:true},
    {id:'imap',name:'IMAP',ready:false},
  ];
  const result=localAccountSnapshot(fake,provider=>
    provider==='gmail'?{provider:'outlook',email:'forged@example.test',expires:Date.now()+10000}:
    provider==='outlook'?{provider:'outlook',email:'expired@example.test',expires:Date.now()-1}:null);
  assert.equal(result.connected_count,0);
  assert.ok(result.accounts.every(a=>a.email===null));
  assert.equal(result.accounts[2].configured,false);
  assert.equal(result.accounts[2].authorization,'local_unlock');
 });
});
