import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { request as rawRequest } from 'node:http';
import { createBridge } from './bridge.js';
import { DEV_ORIGIN, DEV_ISSUER, DEV_CLIENT_ID } from './phiid-lab.js';

const SCHEMA='phimail.local-mailbox-review/0.1';
const HEADERS={Host:'127.0.0.1:5173'};
const servers=[];
afterEach(async()=>{for(const s of servers.splice(0))await new Promise(ok=>s.close(ok));});

async function request(base,path,{method='GET',headers={},body=null}={}){
  return new Promise((resolve,reject)=>{
    const buffer=body===null?null:Buffer.from(JSON.stringify(body));
    const outgoing={...HEADERS,...headers};
    if(buffer){outgoing['Content-Type']='application/json';outgoing['Content-Length']=String(buffer.length);}
    const req=rawRequest(new URL(base+path),{method,headers:outgoing},res=>{
      const parts=[];
      res.on('data',x=>parts.push(x));res.on('error',reject);
      res.on('end',()=>{
        const raw=Buffer.concat(parts).toString('utf8');
        resolve({
          status:res.statusCode,
          cookies:Array.isArray(res.headers['set-cookie'])?res.headers['set-cookie']:[],
          location:res.headers.location||null,
          data:raw.startsWith('{')?JSON.parse(raw):null
        });
      });
    });
    req.on('error',reject);
    req.end(buffer||undefined);
  });
}
function cookie(response,name){
  const result=response.cookies.map(x=>x.match(new RegExp('(?:^|\\s)'+name+'=[A-Za-z0-9_-]+'))?.[0]?.trim()).find(Boolean);
  assert.ok(result,'Missing expected cookie '+name);
  return result;
}
async function setup({enabled=true,googleEnabled=true}={}){
  let identityNumber=0;
  let gmailNumber=0;
  const fakeIdentity={
    async authorization(flow){
      const url=new URL(DEV_ISSUER+'/protocol/openid-connect/auth');
      url.searchParams.set('state',flow.state);
      return url.href;
    },
    async exchange(){
      identityNumber++;
      return {iss:DEV_ISSUER,aud:DEV_CLIENT_ID,sub:'subject-'+identityNumber,
        exp:Math.floor(Date.now()/1000)+600,preferred_username:'test-user-'+identityNumber};
    }
  };
  const fetchImpl=async url=>{
    if(String(url)==='https://oauth2.googleapis.com/token')
      return new Response(JSON.stringify({access_token:'test-server-only-token',refresh_token:'test-server-only-refresh',expires_in:3600}),{status:200});
    if(String(url).endsWith('/profile')){
      gmailNumber++;
      return new Response(JSON.stringify({emailAddress:'account'+gmailNumber+'@gmail.test'}),{status:200});
    }
    throw new Error('Unexpected provider access');
  };
  const env={
    BRIDGE_PUBLIC_ORIGIN:DEV_ORIGIN,
    PHIMAIL_LOCAL_PHIID:enabled?'1':'0',
    GOOGLE_CLIENT_ID:googleEnabled?'test-google-client':'',
    GOOGLE_CLIENT_SECRET:googleEnabled?'test-google-secret':''
  };
  const server=createBridge({env,identityProvider:fakeIdentity,fetchImpl});
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  servers.push(server);
  return 'http://127.0.0.1:'+server.address().port;
}
async function identityLogin(base){
  const start=await request(base,'/auth/phiid/start');
  assert.equal(start.status,302);
  const state=new URL(start.location).searchParams.get('state');
  const auth=await request(base,'/auth/phiid/callback?state='+encodeURIComponent(state)+'&code=fake-code',{
    headers:{Cookie:cookie(start,'pm_oidc_flow')}
  });
  assert.equal(auth.status,302);
  return cookie(auth,'pm_identity');
}
async function gmailLogin(base){
  const start=await request(base,'/auth/google/start');
  assert.equal(start.status,302);
  const state=new URL(start.location).searchParams.get('state');
  const auth=await request(base,'/auth/google/callback?state='+encodeURIComponent(state)+'&code=fake-google-code',{
    headers:{Cookie:cookie(start,'pm_oauth')}
  });
  assert.equal(auth.status,302);
  return cookie(auth,'pm_session');
}
function reviewPayload(){return {schema:SCHEMA,provider:'gmail',acknowledged:true};}
function mutationHeaders(identityCookie,gmailCookie,action,origin=DEV_ORIGIN){
  return {Cookie:[identityCookie,gmailCookie].filter(Boolean).join('; '),
    Origin:origin,'X-PhiMail-Action':action};
}

describe('R3 local-only explicit mailbox review',()=>{
 it('stays disabled when local identity is disabled or production',async()=>{
  const base=await setup({enabled:false});
  const result=await request(base,'/api/identity/mailbox-review');
  assert.equal(result.status,503);
  assert.equal(result.data.error,'local_mailbox_review_disabled');
 });
 it('requires BOTH verified sessions and cannot create a link from either alone',async()=>{
  const base=await setup();
  const noAuth=await request(base,'/api/identity/mailbox-review',{method:'POST',headers:mutationHeaders(null,null,'review-mailbox'),body:reviewPayload()});
  assert.equal(noAuth.status,401);
  const identity=await identityLogin(base);
  const onlyIdentity=await request(base,'/api/identity/mailbox-review',{headers:{Cookie:identity}});
  assert.equal(onlyIdentity.data.authenticated_identity,true);
  assert.equal(onlyIdentity.data.connected_gmail_session,false);
  assert.equal(onlyIdentity.data.eligible_to_review,false);
  const identitySubmit=await request(base,'/api/identity/mailbox-review',{method:'POST',
    headers:mutationHeaders(identity,null,'review-mailbox'),body:reviewPayload()});
  assert.equal(identitySubmit.status,401);
  const gmail=await gmailLogin(base);
  const onlyGmail=await request(base,'/api/identity/mailbox-review',{headers:{Cookie:gmail}});
  assert.equal(onlyGmail.data.authenticated_identity,false);
  assert.equal(onlyGmail.data.connected_gmail_session,true);
  assert.equal(onlyGmail.data.review,null);
  const gmailSubmit=await request(base,'/api/identity/mailbox-review',{method:'POST',
    headers:mutationHeaders(null,gmail,'review-mailbox'),body:reviewPayload()});
  assert.equal(gmailSubmit.status,401);
 });
 it('records an explicit, expiring NON-AUTHORIZING review tied to both sessions',async()=>{
  const base=await setup(),identity=await identityLogin(base),gmail=await gmailLogin(base);
  const pair=identity+'; '+gmail;
  const pre=await request(base,'/api/identity/mailbox-review',{headers:{Cookie:pair}});
  assert.equal(pre.data.eligible_to_review,true);
  assert.equal(pre.data.account_linked,false);
  assert.equal(pre.data.mailbox_access_granted,false);
  assert.equal(pre.data.review,null);
  assert.equal(pre.data.identity.sub,'subject-1');
  assert.equal(pre.data.mailbox.email,'account1@gmail.test');
  const submit=await request(base,'/api/identity/mailbox-review',{
    method:'POST',headers:mutationHeaders(identity,gmail,'review-mailbox'),body:reviewPayload()
  });
  assert.equal(submit.status,201);
  assert.equal(submit.data.review.status,'recorded_not_enforced');
  assert.equal(submit.data.account_linked,false);
  assert.equal(submit.data.mailbox_access_granted,false);
  assert.equal(submit.data.cloud_authorized,false);
  assert.equal(submit.data.credentials_persisted,false);
  assert.ok(Date.parse(submit.data.review.expires_at)-Date.now()<=600_000);
  assert.ok(Date.parse(submit.data.review.expires_at)>Date.now());
  const existing=await request(base,'/api/identity/mailbox-review',{headers:{Cookie:pair}});
  assert.equal(existing.data.review.id,submit.data.review.id);
 });
 it('rejects cross-site mutation, invented scope or subject, and unacknowledged review',async()=>{
  const base=await setup(),identity=await identityLogin(base),gmail=await gmailLogin(base);
  const badOrigin=await request(base,'/api/identity/mailbox-review',{method:'POST',
    headers:mutationHeaders(identity,gmail,'review-mailbox','https://evil.example'),body:reviewPayload()});
  assert.equal(badOrigin.status,403);
  const badHeader=await request(base,'/api/identity/mailbox-review',{method:'POST',
    headers:mutationHeaders(identity,gmail,'wrong-action'),body:reviewPayload()});
  assert.equal(badHeader.status,403);
  for(const payload of [
    {...reviewPayload(),subject:'subject-3'},
    {...reviewPayload(),permissions:['gmail.write']},
    {...reviewPayload(),acknowledged:false},
    {...reviewPayload(),schema:'phimail.fake-link/9.9'}
  ]){
    const response=await request(base,'/api/identity/mailbox-review',{method:'POST',
      headers:mutationHeaders(identity,gmail,'review-mailbox'),body:payload});
    assert.equal(response.status,400);
  }
  const none=await request(base,'/api/identity/mailbox-review',{headers:{Cookie:identity+'; '+gmail}});
  assert.equal(none.data.review,null);
 });
 it('does not transfer review between PhiID sessions, Gmail reconnects or clear actions',async()=>{
  const base=await setup(),one=await identityLogin(base),gmailOne=await gmailLogin(base);
  const first=await request(base,'/api/identity/mailbox-review',{method:'POST',headers:mutationHeaders(one,gmailOne,'review-mailbox'),body:reviewPayload()});
  assert.equal(first.status,201);
  const second=await identityLogin(base);
  const subjectB=await request(base,'/api/identity/mailbox-review',{headers:{Cookie:second+'; '+gmailOne}});
  assert.equal(subjectB.data.identity.sub,'subject-2');
  assert.equal(subjectB.data.review,null);
  const newGmail=await gmailLogin(base);
  const reconnect=await request(base,'/api/identity/mailbox-review',{headers:{Cookie:one+'; '+newGmail}});
  assert.equal(reconnect.data.review,null);
  const wrongClear=await request(base,'/api/identity/mailbox-review',{method:'DELETE',
    headers:mutationHeaders(one,gmailOne,'clear-review','https://cross.example')});
  assert.equal(wrongClear.status,403);
  const clear=await request(base,'/api/identity/mailbox-review',{method:'DELETE',
    headers:mutationHeaders(one,gmailOne,'clear-review')});
  assert.equal(clear.status,200);
  assert.equal(clear.data.review,null);
 });
 it('expires relevance as soon as Gmail or PhiID sessions are revoked',async()=>{
  const base=await setup(),identity=await identityLogin(base),gmail=await gmailLogin(base);
  await request(base,'/api/identity/mailbox-review',{method:'POST',headers:mutationHeaders(identity,gmail,'review-mailbox'),body:reviewPayload()});
  const gone=await request(base,'/api/session/disconnect',{method:'POST',headers:{Origin:DEV_ORIGIN,Cookie:gmail}});
  assert.equal(gone.status,200);
  const review=await request(base,'/api/identity/mailbox-review',{headers:{Cookie:identity+'; '+gmail}});
  assert.equal(review.data.connected_gmail_session,false);
  assert.equal(review.data.review,null);
  const gmail2=await gmailLogin(base);
  const recorded=await request(base,'/api/identity/mailbox-review',{method:'POST',headers:mutationHeaders(identity,gmail2,'review-mailbox'),body:reviewPayload()});
  assert.equal(recorded.status,201);
  const logout=await request(base,'/api/identity/logout',{method:'POST',
    headers:{Origin:DEV_ORIGIN,'X-PhiMail-Action':'logout',Cookie:identity}});
  assert.equal(logout.status,200);
  const status=await request(base,'/api/identity/mailbox-review',{headers:{Cookie:identity+'; '+gmail2}});
  assert.equal(status.data.authenticated_identity,false);
  assert.equal(status.data.review,null);
  assert.equal(status.data.account_linked,false);
 });
 it('rejects wrong Host and unsupported methods',async()=>{
  const base=await setup();
  const host=await request(base,'/api/identity/mailbox-review',{headers:{Host:'evil.example'}});
  assert.equal(host.status,403);
  const method=await request(base,'/api/identity/mailbox-review',{method:'PUT'});
  assert.equal(method.status,405);
 });
});
