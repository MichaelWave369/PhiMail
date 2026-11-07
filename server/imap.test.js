import {afterEach,describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {request as rawHttp} from 'node:http';
import {Readable} from 'node:stream';
import {createBridge} from './bridge.js';
import {createImapReadAdapter,imapReady,firstPlainPart} from './providers/imap.js';

const ORIGIN='http://127.0.0.1:5173';
const ENV={
 BRIDGE_PUBLIC_ORIGIN:ORIGIN,
 IMAP_HOST:'imap.example.test',
 IMAP_PORT:'993',
 IMAP_USERNAME:'tester@example.test',
 IMAP_APP_PASSWORD:'server-secret-app-password',
 IMAP_UNLOCK_KEY:'R7-test-only-unlock-secret-32bytes-long!'}
;
const servers=[];
afterEach(async()=>{for(const server of servers.splice(0))await new Promise(r=>server.close(r));});
function makeFake(){
 const activity=[];
 const state={uidValidity:'11',exists:2,bodyType:'text/plain',body:'Hello from read-only IMAP'};
 const clientFactory=options=>{
  activity.push({method:'construct',options});
  return {
   mailbox:null,
   async connect(){activity.push({method:'connect'});},
   async getMailboxLock(path,options){
    activity.push({method:'lock',path,options});
    this.mailbox={exists:state.exists,uidValidity:state.uidValidity,readOnly:options?.readOnly===true};
    return {release:()=>activity.push({method:'release'})};
   },
   async fetchAll(range,query){
    activity.push({method:'fetchAll',range,query});
    return [
      {uid:41,internalDate:new Date('2026-11-06T18:00:00Z'),size:120,flags:new Set(),
       envelope:{subject:'Earlier',from:[{name:'Author',address:'from@example.test'}],to:[{address:'tester@example.test'}]}},
      {uid:42,internalDate:new Date('2026-11-06T19:00:00Z'),size:200,flags:new Set(['\\Flagged']),
       envelope:{subject:'Latest IMAP',from:[{name:'Friend',address:'friend@example.test'}],to:[{address:'tester@example.test'}]}},
    ].slice(-Number(range.split(':')[1]));
   },
   async fetchOne(uid,fields,opts){
    activity.push({method:'fetchOne',uid,fields,opts});
    return {uid:Number(uid),size:200,flags:new Set(),internalDate:new Date('2026-11-06T19:00:00Z'),
      envelope:{subject:'Latest IMAP',from:[{address:'friend@example.test'}]},
      bodyStructure:{type:state.bodyType,part:'1'}};
   },
   async download(uid,part,opts){
    activity.push({method:'download',uid,part,opts});
    return {content:Readable.from([Buffer.from(state.body)])};
   },
   async logout(){activity.push({method:'logout'});}
  };
 };
 return {activity,state,clientFactory};
}
async function setup(override={},factory=makeFake()){
 const env={...ENV,...override};
 const bridge=createBridge({env,imapClientFactory:factory.clientFactory,
   fetchImpl:async()=>{throw Error('Provider network should not be called')}});
 await new Promise(r=>bridge.listen(0,'127.0.0.1',r));
 servers.push(bridge);
 return {base:'http://127.0.0.1:'+bridge.address().port,factory,env};
}
async function call(base,path,{method='GET',body=null,cookie='',headers={}}={}){
 return new Promise((resolve,reject)=>{
  const textBody=body===null?null:JSON.stringify(body);
  const req=rawHttp(base+path,{method,headers:{
   Host:'127.0.0.1:5173',
   ...(cookie?{Cookie:cookie}:{}),
   ...(textBody?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(textBody)}:{}),
   ...headers
  }},res=>{
   const chunks=[];
   res.on('data',chunk=>chunks.push(chunk));
   res.on('error',reject);
   res.on('end',()=>{
    const raw=Buffer.concat(chunks).toString('utf8');
    resolve({status:res.statusCode,cookies:res.headers['set-cookie']||[],
      data:raw.startsWith('{')?JSON.parse(raw):null,raw});
   });
  });
  req.on('error',reject);req.end(textBody||undefined);
 });
}
async function unlock(base,secret=ENV.IMAP_UNLOCK_KEY){
 return call(base,'/api/imap/connect',{
  method:'POST',body:{unlock:secret},
  headers:{Origin:ORIGIN,'X-PhiMail-Action':'connect-imap'}
 });
}
function cookie(res,name='pm_imap_session'){
 const found=res.cookies.find(x=>x.startsWith(name+'=')&&!x.startsWith(name+'=;'));
 assert.ok(found,'Expected '+name+' cookie');
 return found.split(';')[0];
}
describe('R7 IMAP read-only provider and unlock flow',()=>{
 it('requires exact local origin, private config and TLS server settings',async()=>{
  assert.equal(imapReady({...ENV,BRIDGE_PUBLIC_ORIGIN:'http://localhost:5173'}),false);
  assert.equal(imapReady({...ENV,IMAP_HOST:'127.0.0.1'}),false);
  assert.equal(imapReady({...ENV,IMAP_UNLOCK_KEY:'bad'}),false);
  assert.equal(imapReady({...ENV,NODE_ENV:'production'}),false);
  const disabled=await setup({IMAP_APP_PASSWORD:''});
  const started=await unlock(disabled.base);
  assert.equal(started.status,503);
  const providers=await call(disabled.base,'/api/providers');
  assert.equal(providers.data.providers.find(x=>x.id==='imap').ready,false);
 });
 it('rejects cross-origin attempts and incorrect local unlock phrases',async()=>{
  const {base}=await setup();
  const noOrigin=await call(base,'/api/imap/connect',{
   method:'POST',body:{unlock:ENV.IMAP_UNLOCK_KEY},
   headers:{'X-PhiMail-Action':'connect-imap'}
  });
  assert.equal(noOrigin.status,403);
  const crossOrigin=await call(base,'/api/imap/connect',{
   method:'POST',body:{unlock:ENV.IMAP_UNLOCK_KEY},
   headers:{Origin:'https://evil.example','X-PhiMail-Action':'connect-imap'}
  });
  assert.equal(crossOrigin.status,403);
  const wrongHost=await call(base,'/api/imap/connect',{
   method:'POST',body:{unlock:ENV.IMAP_UNLOCK_KEY},
   headers:{Host:'evil.example',Origin:ORIGIN,'X-PhiMail-Action':'connect-imap'}
  });
  assert.equal(wrongHost.status,403);
  const bad=await unlock(base,'incorrect password');
  assert.equal(bad.status,401);
  assert.ok(!bad.cookies.length);
  const status=await call(base,'/api/session?provider=imap');
  assert.equal(status.data.connected,false);
 });
 it('requires explicit unlock before the configured server mailbox is usable',async()=>{
  const {base,factory}=await setup();
  const denied=await call(base,'/api/mail/messages?provider=imap');
  assert.equal(denied.status,401);
  const logged=await unlock(base);
  assert.equal(logged.status,200);
  assert.equal(logged.data.connected,true);
  assert.equal(logged.data.phiid_linked,false);
  assert.ok(!logged.raw.includes(ENV.IMAP_APP_PASSWORD));
  assert.ok(!logged.raw.includes(ENV.IMAP_UNLOCK_KEY));
  const sessionCookie=cookie(logged);
  assert.ok(logged.cookies.some(x=>x.includes('Path=/api;')&&x.includes('HttpOnly')));
  const status=await call(base,'/api/session?provider=imap',{cookie:sessionCookie});
  assert.equal(status.data.email,ENV.IMAP_USERNAME);
  const google=await call(base,'/api/mail/messages?provider=gmail',{cookie:sessionCookie});
  assert.equal(google.status,401);
  const outlook=await call(base,'/api/mail/messages?provider=outlook',{cookie:sessionCookie});
  assert.equal(outlook.status,401);
  const identity=await call(base,'/api/identity/session',{cookie:sessionCookie});
  assert.notEqual(identity.data?.authenticated,true);
  const opts=factory.activity.find(x=>x.method==='construct').options;
  assert.equal(opts.secure,true);
  assert.equal(opts.tls.rejectUnauthorized,true);
  assert.equal(opts.disableAutoIdle,true);
  assert.equal(opts.logger,false);
  assert.equal(opts.auth.pass,ENV.IMAP_APP_PASSWORD);
  assert.equal(factory.activity.find(x=>x.method==='lock').options.readOnly,true);
 });
 it('lists only bounded recent messages and resolves opaque per-session handles',async()=>{
  const {base,factory}=await setup();
  const logged=await unlock(base),c=cookie(logged);
  const list=await call(base,'/api/mail/messages?provider=imap&limit=2',{cookie:c});
  assert.equal(list.status,200);
  assert.equal(list.data.messages.length,2);
  assert.equal(list.data.messages[0].subject,'Latest IMAP');
  assert.equal(list.data.messages[0].provider,'imap');
  assert.equal(list.data.messages[0].starred,true);
  const handle=list.data.messages[0].id;
  assert.match(handle,/^[A-Za-z0-9_-]{20,60}$/);
  assert.ok(!list.raw.includes('"uid"'));
  const detail=await call(base,'/api/mail/messages/'+handle+'?provider=imap',{cookie:c});
  assert.equal(detail.status,200);
  assert.equal(detail.data.body,'Hello from read-only IMAP');
  const fetchOne=factory.activity.find(x=>x.method==='fetchOne');
  assert.equal(fetchOne.opts.uid,true);
  const part=factory.activity.find(x=>x.method==='download');
  assert.equal(part.opts.maxBytes,100000);
  const unknown=await call(base,'/api/mail/messages/abcdef0123456789abcdef012345?provider=imap',{cookie:c});
  assert.equal(unknown.status,404);
 });
 it('blocks HTML-only mail, attachment parts, and oversized MIME nesting',async()=>{
  const {base,factory}=await setup();
  const session=cookie(await unlock(base));
  factory.state.bodyType='text/html';
  const listing=await call(base,'/api/mail/messages?provider=imap',{cookie:session});
  const id=listing.data.messages[0].id;
  const detail=await call(base,'/api/mail/messages/'+id+'?provider=imap',{cookie:session});
  assert.equal(detail.status,200);
  assert.ok(detail.data.body.includes('No plain-text part'));
  assert.ok(!factory.activity.some(x=>x.method==='download'));
  assert.equal(firstPlainPart({type:'text/plain',disposition:'attachment',part:'2'}),null);
  let deep={type:'text/plain',part:'1'};
  for(let i=0;i<18;i++)deep={type:'multipart/mixed',childNodes:[deep]};
  assert.equal(firstPlainPart(deep),null);
 });
 it('invalidates old handles if the mailbox UIDVALIDITY changes',async()=>{
  const {base,factory}=await setup();
  const c=cookie(await unlock(base));
  const list=await call(base,'/api/mail/messages?provider=imap',{cookie:c});
  factory.state.uidValidity='22';
  const response=await call(base,'/api/mail/messages/'+list.data.messages[0].id+'?provider=imap',{cookie:c});
  assert.equal(response.status,409);
 });
 it('rejects stale handles from other unlock sessions and revokes only local IMAP',async()=>{
  const {base}=await setup();
  const first=cookie(await unlock(base));
  const list=await call(base,'/api/mail/messages?provider=imap',{cookie:first});
  const handle=list.data.messages[0].id;
  const second=cookie(await unlock(base));
  const stolen=await call(base,'/api/mail/messages/'+handle+'?provider=imap',{cookie:second});
  assert.equal(stolen.status,404);
  const malicious=await call(base,'/api/session/disconnect?provider=imap',{
   method:'POST',cookie:second,
   headers:{Origin:'https://evil.example','X-PhiMail-Action':'disconnect-imap'}
  });
  assert.equal(malicious.status,403);
  const logout=await call(base,'/api/session/disconnect?provider=imap',{
   method:'POST',cookie:second,
   headers:{Origin:ORIGIN,'X-PhiMail-Action':'disconnect-imap'}
  });
  assert.equal(logout.status,200);
  assert.equal(logout.data.server_credential_revoked,false);
  assert.equal((await call(base,'/api/session?provider=imap',{cookie:second})).data.connected,false);
  assert.equal((await call(base,'/api/session?provider=imap',{cookie:first})).data.connected,true);
 });
 it('bounds unlock attempts and rejects hostile payload fields',async()=>{
  const {base}=await setup();
  const hostile=await call(base,'/api/imap/connect',{
   method:'POST',body:{unlock:ENV.IMAP_UNLOCK_KEY,server:'evil.example'},
   headers:{Origin:ORIGIN,'X-PhiMail-Action':'connect-imap'}
  });
  assert.equal(hostile.status,400);
  for(let i=0;i<4;i++)assert.equal((await unlock(base,'bad-secret')).status,401);
  assert.equal((await unlock(base)).status,429);
 });
});
