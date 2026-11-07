import {afterEach,describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {createBridge} from './bridge.js';

const ORIGIN='http://127.0.0.1:5173';
const ENV={
  BRIDGE_PUBLIC_ORIGIN:ORIGIN,
  GOOGLE_CLIENT_ID:'google-test-client',GOOGLE_CLIENT_SECRET:'test-google-secret',
  MICROSOFT_CLIENT_ID:'12345678-1234-4234-8234-123456789012',
  MICROSOFT_CLIENT_SECRET:'test-microsoft-secret'
};
const live=[];
afterEach(async()=>{
  for(const bridge of live.splice(0))await new Promise(resolve=>bridge.close(resolve));
});
function request(base,path,{method='GET',cookie='',headers={}}={}){
  return new Promise((resolve,reject)=>{
    const req=httpRequest(base+path,{method,headers:{
      Host:'127.0.0.1:5173',...(cookie?{Cookie:cookie}:{}),...headers
    }},res=>{
      const chunks=[];
      res.on('data',chunk=>chunks.push(chunk));
      res.on('error',reject);
      res.on('end',()=>{
        const text=Buffer.concat(chunks).toString('utf8');
        resolve({status:res.statusCode,body:text,location:res.headers.location,
          cookies:res.headers['set-cookie']||[],json:text.startsWith('{')?JSON.parse(text):null});
      });
    });
    req.on('error',reject);req.end();
  });
}
function takeCookie(res,name){
  const item=res.cookies.find(x=>x.startsWith(name+'=')&&!x.startsWith(name+'=;'));
  assert.ok(item,'Expected '+name+' cookie');
  return item.split(';')[0];
}
async function login(base,provider){
  const outlook=provider==='outlook',prefix=outlook?'/auth/microsoft':'/auth/google';
  const first=await request(base,prefix+'/start');
  assert.equal(first.status,302);
  const state=new URL(first.location).searchParams.get('state');
  const result=await request(base,prefix+'/callback?code=example-code&state='+state,{
    cookie:takeCookie(first,outlook?'pm_ms_flow':'pm_oauth')
  });
  assert.equal(result.status,302);
  return takeCookie(result,outlook?'pm_ms_session':'pm_session');
}
function fakeProvider(){
  const calls={gmail:0,outlook:0};
  let releaseG,releaseM,startedG,startedM;
  const gmailWait=new Promise(resolve=>releaseG=resolve);
  const outlookWait=new Promise(resolve=>releaseM=resolve);
  const gmailStarted=new Promise(resolve=>startedG=resolve);
  const outlookStarted=new Promise(resolve=>startedM=resolve);
  const json=data=>new Response(JSON.stringify(data),{status:200});
  async function fetchImpl(url,options={}){
    const u=String(url);
    const body=options.body;
    if(u==='https://oauth2.googleapis.com/token'){
      if(body?.get('grant_type')==='refresh_token'){
        calls.gmail++;
        startedG();
        await gmailWait;
        return json({access_token:'g-refreshed',refresh_token:'g-rotated',expires_in:3600});
      }
      return json({access_token:'g-old',refresh_token:'g-refresh',expires_in:1});
    }
    if(u==='https://gmail.googleapis.com/gmail/v1/users/me/profile')
      return json({emailAddress:'gmail-owner@example.test'});
    if(u.includes('gmail/v1/users/me/messages?'))return json({messages:[]});
    if(u==='https://login.microsoftonline.com/consumers/oauth2/v2.0/token'){
      if(body?.get('grant_type')==='refresh_token'){
        calls.outlook++;
        startedM();
        await outlookWait;
        return json({token_type:'Bearer',access_token:'m-refreshed',
          refresh_token:'m-rotated',expires_in:3600,
          scope:'User.Read Mail.Read offline_access'});
      }
      return json({token_type:'Bearer',access_token:'m-old',
        refresh_token:'m-refresh',expires_in:1,
        scope:'User.Read Mail.Read offline_access'});
    }
    if(u==='https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName')
      return json({id:'user-1',mail:'outlook-owner@example.test'});
    if(u.includes('graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?'))
      return json({value:[]});
    throw new Error('Unexpected fake provider URL '+u);
  }
  return {fetchImpl,calls,gmailStarted,outlookStarted,
    releaseGmail:()=>releaseG(),releaseOutlook:()=>releaseM()};
}
async function setup(fake){
  const bridge=createBridge({env:ENV,fetchImpl:fake.fetchImpl});
  await new Promise(resolve=>bridge.listen(0,'127.0.0.1',resolve));
  live.push(bridge);
  return 'http://127.0.0.1:'+bridge.address().port;
}
describe('R9 real bridge token refresh and resource boundaries',()=>{
  it('coalesces two concurrent Gmail refreshes while keeping Microsoft separate',async()=>{
    const mock=fakeProvider(),base=await setup(mock);
    const gmail=await login(base,'gmail');
    const outlook=await login(base,'outlook');
    const gmailCalls=[
      request(base,'/api/mail/messages?provider=gmail',{cookie:gmail}),
      request(base,'/api/mail/messages?provider=gmail',{cookie:gmail})
    ];
    const outlookCalls=[
      request(base,'/api/mail/messages?provider=outlook',{cookie:outlook}),
      request(base,'/api/mail/messages?provider=outlook',{cookie:outlook})
    ];
    await Promise.all([mock.gmailStarted,mock.outlookStarted]);
    assert.equal(mock.calls.gmail,1);
    assert.equal(mock.calls.outlook,1);
    mock.releaseGmail();
    mock.releaseOutlook();
    const all=await Promise.all([...gmailCalls,...outlookCalls]);
    assert.deepEqual(all.map(x=>x.status),[200,200,200,200]);
    assert.ok(all.every(x=>Array.isArray(x.json.messages)&&x.json.messages.length===0));
    assert.equal(mock.calls.gmail,1);
    assert.equal(mock.calls.outlook,1);
  });
  it('rejects cross-site and foreign Origin reads even when valid cookies exist',async()=>{
    const mock=fakeProvider(),base=await setup(mock);
    const gmail=await login(base,'gmail');
    const foreign=await request(base,'/api/session',{cookie:gmail,
      headers:{Origin:'https://other.example'}});
    assert.equal(foreign.status,403);
    const sameSiteOtherPort=await request(base,'/api/session',{cookie:gmail,
      headers:{'Sec-Fetch-Site':'same-site'}});
    assert.equal(sameSiteOtherPort.status,403);
    const crossSite=await request(base,'/api/mail/messages',{cookie:gmail,
      headers:{'Sec-Fetch-Site':'cross-site'}});
    assert.equal(crossSite.status,403);
    const foreignOrigin=await request(base,'/api/mail/messages',{cookie:gmail,
      headers:{Origin:'https://other.example'}});
    assert.equal(foreignOrigin.status,403);
    const ok=await request(base,'/api/session',{cookie:gmail,
      headers:{Origin:ORIGIN,'Sec-Fetch-Site':'same-origin'}});
    assert.equal(ok.status,200);
    assert.equal(ok.json.connected,true);
  });
});
