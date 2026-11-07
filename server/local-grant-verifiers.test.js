import {afterEach,describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as rawHttp} from 'node:http';
import {createPhiIdLab,DEV_ISSUER,DEV_CLIENT_ID,DEV_ORIGIN} from './phiid-lab.js';
import {createMicrosoftLab} from './outlook-lab.js';
import {createOutlookReadAdapter} from './providers/outlook.js';
import {createLocalGrantVerifiers} from './local-grant-verifiers.js';
import {createMailboxGrantAuthority,MailboxGrantDenied} from './mailbox-grants.js';

const ENV={
  BRIDGE_PUBLIC_ORIGIN:DEV_ORIGIN,PHIMAIL_LOCAL_PHIID:'1',
  MICROSOFT_CLIENT_ID:'12345678-1234-4234-8234-123456789012',
  MICROSOFT_CLIENT_SECRET:'r12-synthetic-test-secret'
};
const servers=[];
afterEach(async()=>{
  for(const server of servers.splice(0))await new Promise(resolve=>server.close(resolve));
});
function request(base,path,{method='GET',cookies='',headers={}}={}){
  return new Promise((resolve,reject)=>{
    const req=rawHttp(base+path,{method,headers:{
      Host:'127.0.0.1:5173',...(cookies?{Cookie:cookies}:{}),...headers
    }},res=>{
      const chunks=[];
      res.on('data',x=>chunks.push(x));
      res.on('error',reject);
      res.on('end',()=>{
        const body=Buffer.concat(chunks).toString('utf8');
        resolve({status:res.statusCode,location:res.headers.location,
          cookies:res.headers['set-cookie']||[],
          body,data:body.startsWith('{')?JSON.parse(body):null});
      });
    });
    req.on('error',reject);
    req.end();
  });
}
function cookie(res,name){
  const match=res.cookies.find(x=>x.startsWith(name+'=')&&!x.startsWith(name+'=;'));
  assert.ok(match,'Missing '+name+' cookie');
  return match.split(';')[0];
}
function fakeOidc(){
  return {
    async authorization(flow){
      const uri=new URL(DEV_ISSUER+'/protocol/openid-connect/auth');
      uri.searchParams.set('state',flow.state);
      return uri.href;
    },
    async exchange(_url,flow){
      return {
        iss:DEV_ISSUER,aud:DEV_CLIENT_ID,sub:'validated-dev-user',
        exp:Math.floor(Date.now()/1000)+600,nonce:flow.nonce,
        preferred_username:'Local User'
      };
    }
  };
}
async function setup({env={},graphWait=null}={}){
  const state={graphId:'ms-stable-graph-id-777',graphCalls:0,oidcCalls:0};
  const options={...ENV,...env};
  const identityLab=createPhiIdLab({env:options,provider:fakeOidc()});
  const requestProvider=async(url,opts={})=>{
    const link=String(url);
    if(link==='https://login.microsoftonline.com/consumers/oauth2/v2.0/token'){
      assert.equal(opts.method,'POST');
      return {token_type:'Bearer',access_token:'synthetic-graph-access',
        refresh_token:'synthetic-graph-refresh',expires_in:3600,
        scope:'Mail.Read User.Read offline_access'};
    }
    if(link==='https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName'){
      state.graphCalls++;
      if(graphWait)await graphWait(state.graphCalls);
      return {id:state.graphId,mail:'graph-owner@example.test',
        userPrincipalName:'graph-owner@example.test'};
    }
    throw Error('Unexpected provider destination: '+link);
  };
  const graphAdapter=createOutlookReadAdapter({
    requestProvider,
    accessToken:async()=>{throw Error('Not used by direct Graph /me profile')},
    ready:true
  });
  const microsoftLab=createMicrosoftLab({
    env:options,requestProvider,profile:token=>graphAdapter.profile(token)
  });
  const verifiers=createLocalGrantVerifiers({
    env:options,identityLab,microsoftLab
  });
  const authority=createMailboxGrantAuthority(verifiers);
  const server=createServer((req,res)=>{
    const url=new URL(req.url,DEV_ORIGIN);
    Promise.resolve((async()=>{
      if(await microsoftLab.handle(req,res,url.pathname,url))return;
      if(await identityLab.handle(req,res,url.pathname,url))return;
      if(url.pathname==='/__test__/proof'){
        const provider=url.searchParams.get('provider')||'outlook';
        const proof=await Promise.allSettled([
          verifiers.verifyIdentity(req),
          verifiers.verifyMailbox({request:req,provider})
        ]);
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify(proof.map(x=>x.status==='fulfilled'?{
          ok:true,value:x.value
        }:{ok:false,error:'Mailbox authorization denied'})));
        return;
      }
      if(url.pathname==='/__test__/intent'){
        const intent=await authority.begin({
          identityEvidence:req,
          mailboxEvidence:{request:req,provider:url.searchParams.get('provider')||'outlook'},
          requestedCapabilities:['read:inbox','read:message']
        });
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify(intent));
        return;
      }
      if(url.pathname==='/__test__/disconnect-outlook'){
        microsoftLab.revoke(req);
        res.writeHead(200);res.end();return;
      }
      res.writeHead(404);res.end();
    })()).catch(error=>{
      res.writeHead(error instanceof MailboxGrantDenied?403:500,{
        'Content-Type':'application/json'
      });
      res.end(JSON.stringify({error:error instanceof MailboxGrantDenied?
        'mailbox_grant_denied':'unexpected_test_failure'}));
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  servers.push(server);
  return {base:'http://127.0.0.1:'+server.address().port,
    state,verifiers,authority};
}
async function oidcLogin(base){
  const start=await request(base,'/auth/phiid/start');
  assert.equal(start.status,302);
  const url=new URL(start.location);
  const result=await request(base,
    '/auth/phiid/callback?code=verified-synthetic&state='+url.searchParams.get('state'),
    {cookies:cookie(start,'pm_oidc_flow')});
  assert.equal(result.status,302);
  return cookie(result,'pm_identity');
}
async function outlookLogin(base){
  const start=await request(base,'/auth/microsoft/start');
  assert.equal(start.status,302);
  const url=new URL(start.location);
  const result=await request(base,
    '/auth/microsoft/callback?code=verified-synthetic&state='+url.searchParams.get('state'),
    {cookies:cookie(start,'pm_ms_flow')});
  assert.equal(result.status,302);
  return cookie(result,'pm_ms_session');
}
async function proof(base,cookies,provider='outlook'){
  const response=await request(base,'/__test__/proof?provider='+provider,{cookies});
  assert.equal(response.status,200);
  return JSON.parse(response.body);
}
describe('R12 server-held PhiID + Microsoft Graph evidence adapters',()=>{
  it('requires a real local verifier pair and never enables in production',async()=>{
    assert.throws(()=>createLocalGrantVerifiers(),TypeError);
    assert.throws(()=>createLocalGrantVerifiers({
      identityLab:{lookupSession(){}}
    }),TypeError);
    const h=await setup({env:{NODE_ENV:'production',PHIMAIL_LOCAL_PHIID:''}});
    assert.equal(h.verifiers.enabled,false);
    assert.deepEqual(h.verifiers.verifiedProviders,[]);
    const result=await proof(h.base,'');
    assert.deepEqual(result.map(x=>x.ok),[false,false]);
  });
  it('rejects identity alone, mailbox alone, and forged browser-supplied credentials',async()=>{
    const h=await setup();
    assert.deepEqual((await proof(h.base,'')).map(x=>x.ok),[false,false]);
    const identity=await oidcLogin(h.base);
    const justIdentity=await proof(h.base,identity);
    assert.deepEqual(justIdentity.map(x=>x.ok),[true,false]);
    const outlook=await outlookLogin(h.base);
    const justOutlook=await proof(h.base,outlook);
    assert.deepEqual(justOutlook.map(x=>x.ok),[false,true]);
    assert.equal((await request(h.base,'/__test__/intent',{cookies:identity})).status,403);
    assert.equal((await request(h.base,'/__test__/intent',{cookies:outlook})).status,403);
    await assert.rejects(h.verifiers.verifyIdentity({
      profile:{authenticated:true,issuer:DEV_ISSUER,sub:'validated-dev-user'}
    }),MailboxGrantDenied);
    await assert.rejects(h.verifiers.verifyMailbox({
      provider:'outlook',accountId:'forged-id',email:'graph-owner@example.test'
    }),MailboxGrantDenied);
  });
  it('proves both sessions using pinned OIDC claims and a fresh fixed Graph /me read',async()=>{
    const h=await setup();
    const identity=await oidcLogin(h.base),outlook=await outlookLogin(h.base);
    const cookies=identity+'; '+outlook;
    const before=h.state.graphCalls;
    const result=await proof(h.base,cookies);
    assert.deepEqual(result.map(x=>x.ok),[true,true]);
    assert.equal(result[0].value.issuer,DEV_ISSUER);
    assert.equal(result[0].value.subject,'validated-dev-user');
    assert.equal(result[1].value.provider,'outlook');
    assert.equal(result[1].value.accountId,'microsoft-consumers:ms-stable-graph-id-777');
    assert.ok(h.state.graphCalls>before);
    assert.match(result[0].value.sessionKey,/^[A-Za-z0-9_-]{20,128}$/);
    assert.match(result[1].value.sessionKey,/^[A-Za-z0-9_-]{20,128}$/);
    assert.notEqual(result[0].value.sessionKey,result[1].value.sessionKey);
    const second=await proof(h.base,cookies);
    assert.equal(second[0].value.sessionKey,result[0].value.sessionKey);
    assert.equal(second[1].value.sessionKey,result[1].value.sessionKey);
    assert.ok(!JSON.stringify(result).includes('synthetic-graph-access'));
    assert.ok(!JSON.stringify(result).includes('synthetic-graph-refresh'));
    const intent=await request(h.base,'/__test__/intent',{cookies});
    assert.equal(intent.status,200);
    assert.equal(intent.data.schema,'phimail.mailbox-intent/v0.1');
    assert.equal(intent.data.mailbox.accountId,result[1].value.accountId);
    await assert.rejects(h.authority.approve({
      intentId:intent.data.intentId,
      approvalEvidence:{acknowledged:true,
        schema:'phimail.local-mailbox-review/0.1'}
    }),MailboxGrantDenied);
    // The production bridge NEVER exposes /__test__ routes; this server is
    // an isolated in-test harness for server-held proof integration only.
  });
  it('does not accept Gmail or IMAP as provider ownership proof',async()=>{
    const h=await setup();
    const identity=await oidcLogin(h.base),outlook=await outlookLogin(h.base);
    const cookies=identity+'; '+outlook;
    const before=h.state.graphCalls;
    for(const provider of ['gmail','imap','smtp']){
      const item=await proof(h.base,cookies,provider);
      assert.equal(item[0].ok,true);
      assert.equal(item[1].ok,false);
      assert.equal((await request(h.base,'/__test__/intent?provider='+provider,
        {cookies})).status,403);
    }
    assert.equal(h.state.graphCalls,before);
  });
  it('fails closed if Graph /me returns a different account after OAuth',async()=>{
    const h=await setup();
    const identity=await oidcLogin(h.base),outlook=await outlookLogin(h.base);
    const cookies=identity+'; '+outlook;
    h.state.graphId='replaced-graph-user-id';
    const result=await proof(h.base,cookies);
    assert.equal(result[0].ok,true);
    assert.equal(result[1].ok,false);
    assert.equal((await request(h.base,'/__test__/intent',{cookies})).status,403);
  });
  it('rejects stale sessions after Microsoft revoke and PhiID logout',async()=>{
    const h=await setup();
    const identity=await oidcLogin(h.base),outlook=await outlookLogin(h.base);
    const cookies=identity+'; '+outlook;
    assert.deepEqual((await proof(h.base,cookies)).map(x=>x.ok),[true,true]);
    const drop=await request(h.base,'/__test__/disconnect-outlook',{cookies});
    assert.equal(drop.status,200);
    assert.deepEqual((await proof(h.base,cookies)).map(x=>x.ok),[true,false]);
    const logout=await request(h.base,'/api/identity/logout',{
      method:'POST',cookies,
      headers:{Origin:DEV_ORIGIN,'X-PhiMail-Action':'logout'}
    });
    assert.equal(logout.status,200);
    assert.deepEqual((await proof(h.base,cookies)).map(x=>x.ok),[false,false]);
  });
  it('rejects cookies under forged Host and loops through live session stores',async()=>{
    const h=await setup();
    const identity=await oidcLogin(h.base),outlook=await outlookLogin(h.base);
    const cookies=identity+'; '+outlook;
    const res=await request(h.base,'/__test__/proof',{cookies,headers:{Host:'other.example'}});
    assert.equal(res.status,200);
    assert.deepEqual(JSON.parse(res.body).map(x=>x.ok),[false,false]);
    const duplicate=await request(h.base,'/__test__/proof',{cookies: cookies+'; '+outlook});
    assert.deepEqual(JSON.parse(duplicate.body).map(x=>x.ok),[true,false]);
  });
  it('blocks a Graph proof that finishes after Microsoft logout',async()=>{
    let onStart,release;
    const entered=new Promise(resolve=>onStart=resolve);
    const held=new Promise(resolve=>release=resolve);
    const h=await setup({graphWait:async count=>{
      // First /me is required during the OAuth callback.
      if(count===2){onStart();await held;}
    }});
    const identity=await oidcLogin(h.base),outlook=await outlookLogin(h.base);
    const cookies=identity+'; '+outlook;
    const verifying=proof(h.base,cookies);
    await entered;
    await request(h.base,'/__test__/disconnect-outlook',{cookies});
    release();
    const outcome=await verifying;
    assert.deepEqual(outcome.map(x=>x.ok),[true,false]);
  });
});
