import {afterEach,describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {createBridge} from './bridge.js';
import {createOutlookReadAdapter,graphEnvelope,graphPlainBody} from './providers/outlook.js';
import {validateMicrosoftToken,MICROSOFT_ORIGIN} from './outlook-lab.js';

const MS_ID='12345678-1234-4234-8234-123456789012';
const ENV={
  BRIDGE_PUBLIC_ORIGIN:MICROSOFT_ORIGIN, MICROSOFT_CLIENT_ID:MS_ID,
  MICROSOFT_CLIENT_SECRET:'test-only-server-secret',
  GOOGLE_CLIENT_ID:'google-client',GOOGLE_CLIENT_SECRET:'google-server-only'
};
const GOOGLE_ID='g1',MS_RAW_ID='AAMk-Special/+=ID';
const running=[];
afterEach(async()=>{for(const server of running.splice(0))await new Promise(done=>server.close(done));});
function fakeProviders({badScope=false,html=false}={}){
  const calls=[];
  const fake=async(url,opts={})=>{
    const str=String(url);
    calls.push({url:str,auth:opts.headers?.Authorization||null,method:opts.method||'GET'});
    let payload;
    if(str==='https://login.microsoftonline.com/consumers/oauth2/v2.0/token'){
      payload={token_type:'Bearer',access_token:'ms-private-token',refresh_token:'ms-private-refresh',
        expires_in:3600,scope:badScope?'User.Read':'Mail.Read User.Read offline_access'};
    }else if(str==='https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName'){
      payload={id:'ms-user-1',mail:'ms-owner@example.test'};
    }else if(str.includes('/me/mailFolders/inbox/messages?')){
      payload={value:[{
        id:MS_RAW_ID,conversationId:'conversation-one',subject:'Graph inbox note',
        from:{emailAddress:{name:'Sender',address:'sender@example.test'}},
        toRecipients:[{emailAddress:{address:'ms-owner@example.test'}}],
        receivedDateTime:'2026-11-06T18:00:00Z',
        bodyPreview:'Plain preview',isRead:false,
        flag:{flagStatus:'notFlagged'}
      }], '@odata.nextLink':'https://graph.microsoft.com/v1.0/next-page'};
    }else if(str.includes('/me/messages/')){
      payload={
        id:MS_RAW_ID,subject:'Graph inbox note',isRead:false,
        receivedDateTime:'2026-11-06T18:00:00Z',
        body:{contentType:html?'html':'text',content:html?'<script>tracker</script>':'A safe Graph plain-text body'}
      };
    }else if(str==='https://oauth2.googleapis.com/token'){
      payload={access_token:'gmail-token',expires_in:3600};
    }else if(str==='https://gmail.googleapis.com/gmail/v1/users/me/profile'){
      payload={emailAddress:'gmail-owner@example.test'};
    }else if(str.includes('gmail/v1/users/me/messages?')){
      payload={messages:[{id:GOOGLE_ID}]};
    }else if(str.includes('gmail/v1/users/me/messages/')){
      payload={
        id:GOOGLE_ID,snippet:'Gmail preview',internalDate:'1760000000000',
        payload:{headers:[{name:'Subject',value:'Gmail subject'}]},
      };
    }else throw Error('Unexpected external URL: '+str);
    return new Response(JSON.stringify(payload),{status:200});
  };
  return {fake,calls};
}
async function setup(overrides={},providerOptions={}){
  const mocks=fakeProviders(providerOptions);
  const bridge=createBridge({env:{...ENV,...overrides},fetchImpl:mocks.fake});
  await new Promise(done=>bridge.listen(0,'127.0.0.1',done));
  running.push(bridge);
  return {base:'http://127.0.0.1:'+bridge.address().port,...mocks};
}
function request(base,path,{method='GET',cookies='',headers={}}={}){
  return new Promise((resolve,reject)=>{
    const req=httpRequest(base+path,{method,headers:{Host:'127.0.0.1:5173',
      ...(cookies?{Cookie:cookies}:{}),...headers}},res=>{
      const chunks=[];
      res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);
      res.on('end',()=>{
        const body=Buffer.concat(chunks).toString('utf8');
        resolve({
          status:res.statusCode,
          data:body&&body.startsWith('{')?JSON.parse(body):null,
          location:res.headers.location,
          cookies:Array.isArray(res.headers['set-cookie'])?res.headers['set-cookie']:[],
          body
        });
      });
    });
    req.on('error',reject);req.end();
  });
}
function takeCookie(res,name){
  const candidate=res.cookies.find(s=>s.startsWith(name+'=')&&!s.startsWith(name+'=;'));
  assert.ok(candidate,'Expected cookie '+name);
  return candidate.split(';')[0];
}
async function msLogin(base,priorRotation=''){
  const start=await request(base,'/auth/microsoft/start');
  assert.equal(start.status,302);
  const dest=new URL(start.location);
  assert.equal(dest.host,'login.microsoftonline.com');
  assert.equal(dest.pathname,'/consumers/oauth2/v2.0/authorize');
  assert.equal(dest.searchParams.get('code_challenge_method'),'S256');
  assert.equal(dest.searchParams.get('redirect_uri'),MICROSOFT_ORIGIN+'/auth/microsoft/callback');
  const flow=takeCookie(start,'pm_ms_flow');
  const state=dest.searchParams.get('state');
  const cb=await request(base,'/auth/microsoft/callback?code=test-code&state='+encodeURIComponent(state),
    {cookies:[flow,priorRotation].filter(Boolean).join('; ')});
  return {start,cb,flow,state};
}
async function gmailLogin(base){
  const start=await request(base,'/auth/google/start');
  const state=new URL(start.location).searchParams.get('state');
  const callback=await request(base,'/auth/google/callback?code=test-code&state='+state,{
    cookies:takeCookie(start,'pm_oauth')
  });
  assert.equal(callback.status,302);
  return takeCookie(callback,'pm_session');
}

describe('R6 Outlook Graph read-only laboratory',()=>{
  it('fails closed without exact local origin or Microsoft credentials',async()=>{
    const a=await setup({MICROSOFT_CLIENT_ID:''});
    const no=await request(a.base,'/auth/microsoft/start');
    assert.equal(no.status,503);
    const cat=await request(a.base,'/api/providers');
    assert.equal(cat.data.providers.find(x=>x.id==='outlook').ready,false);
    const b=await setup({BRIDGE_PUBLIC_ORIGIN:'http://localhost:5173'});
    const blocked=await request(b.base,'/auth/microsoft/start');
    assert.equal(blocked.status,503);
  });
  it('requires state, one-use flow and denies tampering before token exchange',async()=>{
    const {base,calls}=await setup();
    const forged=await request(base,'/auth/microsoft/callback?code=x&state=y');
    assert.equal(forged.status,400);
    const start=await request(base,'/auth/microsoft/start');
    const flow=takeCookie(start,'pm_ms_flow');
    const state=new URL(start.location).searchParams.get('state');
    const wrong=await request(base,'/auth/microsoft/callback?code=x&state=tampered',{cookies:flow});
    assert.equal(wrong.status,400);
    const replay=await request(base,'/auth/microsoft/callback?code=x&state='+state,{cookies:flow});
    assert.equal(replay.status,400);
    assert.equal(calls.length,0);
    const second=await request(base,'/auth/microsoft/start');
    const f=takeCookie(second,'pm_ms_flow'),s=new URL(second.location).searchParams.get('state');
    const dup=await request(base,'/auth/microsoft/callback?code=x&code=y&state='+s,{cookies:f});
    assert.equal(dup.status,400);
  });
  it('creates an independent Outlook bearer session and never authorizes Gmail or PhiID',async()=>{
    const {base,calls}=await setup();
    const auth=await msLogin(base);
    assert.equal(auth.cb.status,302);
    assert.equal(auth.cb.location,MICROSOFT_ORIGIN+'/?outlook=connected');
    assert.ok(!auth.cb.body.includes('ms-private-token'));
    const ms=takeCookie(auth.cb,'pm_ms_session');
    const rotation=takeCookie(auth.cb,'pm_ms_rotation');
    assert.ok(auth.cb.cookies.some(c=>c.startsWith('pm_ms_session=')&&c.includes('Path=/api')));
    assert.ok(auth.cb.cookies.some(c=>c.startsWith('pm_ms_rotation=')&&c.includes('Path=/auth/microsoft')));
    const s=await request(base,'/api/session?provider=outlook',{cookies:ms});
    assert.equal(s.data.connected,true);
    assert.equal(s.data.provider,'outlook');
    assert.equal(s.data.email,'ms-owner@example.test');
    const g=await request(base,'/api/mail/messages?provider=gmail',{cookies:ms});
    assert.equal(g.status,401);
    const i=await request(base,'/api/identity/session',{cookies:ms});
    assert.notEqual(i.data.authenticated,true);
    const list=await request(base,'/api/mail/messages?provider=outlook&limit=15',{cookies:ms});
    assert.equal(list.status,200);
    assert.equal(list.data.messages.length,1);
    assert.equal(list.data.messages[0].provider,'outlook');
    assert.equal(list.data.messages[0].subject,'Graph inbox note');
    assert.equal(list.data.messages[0].unread,true);
    assert.equal(list.data.nextPageAvailable,true);
    const id=list.data.messages[0].id;
    assert.ok(/^[a-zA-Z0-9_-]+$/.test(id));
    assert.ok(!JSON.stringify(list.data).includes(MS_RAW_ID));
    const detail=await request(base,'/api/mail/messages/'+id+'?provider=outlook',{cookies:ms});
    assert.equal(detail.status,200);
    assert.equal(detail.data.body,'A safe Graph plain-text body');
    const guess=await request(base,'/api/mail/messages/AAAAAAAAAAAAAAAAAAAAAAAA?provider=outlook',{cookies:ms});
    assert.equal(guess.status,404);
    assert.ok(calls.some(c=>c.url.includes('/me/messages/')&&c.auth==='Bearer ms-private-token'));
    assert.ok(calls.every(c=>!c.url.includes('graph.microsoft.com')||c.method==='GET'));
    assert.ok(rotation);
  });
  it('isolates two simultaneous real-provider sessions and supports explicit selection',async()=>{
    const {base}=await setup();
    const outlook=await msLogin(base);
    const microsoftCookie=takeCookie(outlook.cb,'pm_ms_session');
    const gmailCookie=await gmailLogin(base);
    const both=microsoftCookie+'; '+gmailCookie;
    const x=await request(base,'/api/session?provider=outlook',{cookies:both});
    const y=await request(base,'/api/session?provider=gmail',{cookies:both});
    const fallback=await request(base,'/api/session',{cookies:both});
    assert.equal(x.data.email,'ms-owner@example.test');
    assert.equal(y.data.email,'gmail-owner@example.test');
    assert.equal(fallback.data.provider,'gmail');
    const bad=await request(base,'/api/session?provider=imap',{cookies:both});
    assert.equal(bad.status,400);
    const bad2=await request(base,'/api/mail/messages?provider=outlook&provider=gmail',{cookies:both});
    assert.equal(bad2.status,400);
    const quit=await request(base,'/api/session/disconnect?provider=outlook',{
      method:'POST',cookies:both,headers:{Origin:MICROSOFT_ORIGIN,'X-PhiMail-Action':'disconnect-outlook'}
    });
    assert.equal(quit.status,200);
    assert.equal(quit.data.remote_token_revoked,false);
    const after=await request(base,'/api/session?provider=outlook',{cookies:both});
    const gmailAfter=await request(base,'/api/session?provider=gmail',{cookies:both});
    assert.equal(after.data.connected,false);
    assert.equal(gmailAfter.data.connected,true);
  });
  it('refuses cross-origin Outlook logout and incorrect host',async()=>{
    const {base}=await setup();
    const login=await msLogin(base);
    const ms=takeCookie(login.cb,'pm_ms_session');
    const csrf=await request(base,'/api/session/disconnect?provider=outlook',{
      method:'POST',cookies:ms,headers:{Origin:'https://evil.example','X-PhiMail-Action':'disconnect-outlook'}
    });
    assert.equal(csrf.status,403);
    const still=await request(base,'/api/session?provider=outlook',{cookies:ms});
    assert.equal(still.data.connected,true);
    const wrongHost=await request(base,'/auth/microsoft/start',{headers:{Host:'evil.example'}});
    assert.equal(wrongHost.status,403);
  });
  it('rotates Outlook session independently on OAuth reconnect',async()=>{
    const {base}=await setup();
    const first=await msLogin(base);
    const old=takeCookie(first.cb,'pm_ms_session');
    const rotation=takeCookie(first.cb,'pm_ms_rotation');
    const second=await msLogin(base,rotation);
    assert.equal(second.cb.status,302);
    const newer=takeCookie(second.cb,'pm_ms_session');
    assert.notEqual(newer,old);
    assert.equal((await request(base,'/api/session?provider=outlook',{cookies:old})).data.connected,false);
    assert.equal((await request(base,'/api/session?provider=outlook',{cookies:newer})).data.connected,true);
  });
  it('rejects grants missing Mail.Read and never produces a session',async()=>{
    const {base}=await setup({},{badScope:true});
    const auth=await msLogin(base);
    assert.equal(auth.cb.status,401);
    assert.ok(!auth.cb.cookies.some(x=>x.startsWith('pm_ms_session=')));
    assert.throws(()=>validateMicrosoftToken({token_type:'Bearer',access_token:'x',expires_in:3600,scope:'User.Read'}),e=>e.status===403);
  });
  it('rejects Graph HTML bodies rather than rendering markup',async()=>{
    const {base}=await setup({},{html:true});
    const auth=await msLogin(base);
    const cookie=takeCookie(auth.cb,'pm_ms_session');
    const listing=await request(base,'/api/mail/messages?provider=outlook',{cookies:cookie});
    const id=listing.data.messages[0].id;
    const detail=await request(base,'/api/mail/messages/'+id+'?provider=outlook',{cookies:cookie});
    assert.equal(detail.status,200);
    assert.ok(!detail.data.body.includes('<script>'));
    assert.ok(detail.data.body.includes('No plain-text body'));
  });
  it('normalizes malformed Graph dates and rejects bad IDs',()=>{
    const handle='AbCdEfGhIjKlMnOpQrStUvWx';
    const envelope=graphEnvelope({id:MS_RAW_ID,receivedDateTime:'garbage'},'a@example.test',handle);
    assert.equal(envelope.date,'1970-01-01T00:00:00.000Z');
    assert.throws(()=>graphEnvelope({id:'../../../secret'},'a@example.test',handle));
    assert.equal(graphPlainBody({body:{contentType:'html',content:'<b>x</b>'}}).includes('<b>'),false);
  });
});
