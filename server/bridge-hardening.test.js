import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from './bridge.js';

const ENV = {
  GOOGLE_CLIENT_ID:'test-client',
  GOOGLE_CLIENT_SECRET:'test-secret',
  BRIDGE_PUBLIC_ORIGIN:'http://localhost:5173'
};
const servers=[];
afterEach(async()=>{for(const s of servers.splice(0)) await new Promise(resolve=>s.close(resolve));});
async function start(mock){
  const bridge=createBridge({env:ENV,fetchImpl:mock});
  await new Promise(resolve=>bridge.listen(0,'127.0.0.1',resolve));
  servers.push(bridge);
  return 'http://127.0.0.1:'+bridge.address().port;
}
function mockProvider({tokenSize=0, fullOversize=false, fullPayload=null, listEntries=[]}={}){
  return async (url)=>{
    const u=String(url);
    let response;
    if(u.includes('/token')){
      response=tokenSize ? {access_token:'A'.repeat(tokenSize),expires_in:3600} :
        {access_token:'server-access-token',refresh_token:'server-refresh-token',expires_in:3600};
    }else if(u.endsWith('/profile')){
      response={emailAddress:'test-inbox@gmail.test'};
    }else if(u.includes('/messages?')){
      response={messages:listEntries};
    }else if(u.includes('format=metadata')){
      response={id:'m1',snippet:'hello',internalDate:'99999999999999999999',payload:{headers:[{name:'Subject',value:'A test'}]}};
    }else if(u.includes('format=full')){
      response=fullOversize ? {id:'m1',junk:'x'.repeat(1_100_000)} :
        {id:'m1',internalDate:'1750000000000',payload:fullPayload || {mimeType:'text/plain',body:{data:Buffer.from('Text here').toString('base64url')}}};
    }else{
      throw new Error('Unexpected provider request '+u);
    }
    return new Response(JSON.stringify(response),{status:200});
  };
}
async function oauth(base, priorSession=null){
  const startResponse=await fetch(base+'/auth/google/start',{redirect:'manual'});
  assert.equal(startResponse.status,302);
  const auth=new URL(startResponse.headers.get('location'));
  const flow=startResponse.headers.get('set-cookie').match(/pm_oauth=[A-Za-z0-9_-]+/)?.[0];
  assert.ok(flow);
  const cookies=[flow,priorSession].filter(Boolean).join('; ');
  const callback=await fetch(base+'/auth/google/callback?state='+encodeURIComponent(auth.searchParams.get('state'))+'&code=fake-code',{
    headers:{Cookie:cookies},redirect:'manual'
  });
  assert.equal(callback.status,302);
  const cookieStrings=callback.headers.getSetCookie();
  const issued=cookieStrings.filter(x=>x.startsWith('pm_session=')&&!x.startsWith('pm_session=;')).at(-1);
  assert.ok(issued,'Missing root session cookie');
  assert.match(issued,/Path=\/(?:;|$)/);
  assert.ok(cookieStrings.some(x=>x.includes('pm_session=; Path=/api; Max-Age=0')));
  return {sid:issued.match(/pm_session=[A-Za-z0-9_-]+/)[0],callback};
}

describe('R4 Gmail bridge hardening and session isolation',()=>{
  it('rotates the previous Gmail session across OAuth callbacks',async()=>{
    const base=await start(mockProvider());
    const first=await oauth(base);
    const before=await (await fetch(base+'/api/session',{headers:{Cookie:first.sid}})).json();
    assert.equal(before.connected,true);
    const second=await oauth(base,first.sid);
    assert.notEqual(first.sid,second.sid);
    const old=await (await fetch(base+'/api/session',{headers:{Cookie:first.sid}})).json();
    const current=await (await fetch(base+'/api/session',{headers:{Cookie:second.sid}})).json();
    assert.equal(old.connected,false);
    assert.equal(current.connected,true);
  });
  it('fails closed on duplicate session cookie names and clears both old and new paths',async()=>{
    const base=await start(mockProvider()),{sid}=await oauth(base);
    const duplicate=await (await fetch(base+'/api/session',{
      headers:{Cookie:sid+'; pm_session=differentcookievalueabcdefgh1234567890'}
    })).json();
    assert.equal(duplicate.connected,false);
    const logout=await fetch(base+'/api/session/disconnect',{
      method:'POST',headers:{Origin:'http://localhost:5173',Cookie:sid}
    });
    assert.equal(logout.status,200);
    const resets=logout.headers.getSetCookie();
    assert.ok(resets.some(x=>x.includes('Path=/api; Max-Age=0')));
    assert.ok(resets.some(x=>x.includes('Path=/; Max-Age=0')));
  });
  it('refuses duplicate OAuth state and callback codes',async()=>{
    const base=await start(mockProvider());
    const first=await fetch(base+'/auth/google/start',{redirect:'manual'});
    const state=new URL(first.headers.get('location')).searchParams.get('state');
    const flow=first.headers.get('set-cookie').match(/pm_oauth=[A-Za-z0-9_-]+/)[0];
    const duplicate=await fetch(base+'/auth/google/callback?state='+state+'&state='+state+'&code=fake',{headers:{Cookie:flow},redirect:'manual'});
    assert.equal(duplicate.status,400);
    const second=await fetch(base+'/auth/google/start',{redirect:'manual'});
    const state2=new URL(second.headers.get('location')).searchParams.get('state');
    const flow2=second.headers.get('set-cookie').match(/pm_oauth=[A-Za-z0-9_-]+/)[0];
    const badCode=await fetch(base+'/auth/google/callback?state='+state2+'&code=one&code=two',{headers:{Cookie:flow2},redirect:'manual'});
    assert.equal(badCode.status,400);
  });
  it('caps token responses before parsing and never creates a session',async()=>{
    const base=await start(mockProvider({tokenSize:100_000}));
    const first=await fetch(base+'/auth/google/start',{redirect:'manual'});
    const state=new URL(first.headers.get('location')).searchParams.get('state');
    const flow=first.headers.get('set-cookie').match(/pm_oauth=[A-Za-z0-9_-]+/)[0];
    const callback=await fetch(base+'/auth/google/callback?state='+state+'&code=one',{headers:{Cookie:flow},redirect:'manual'});
    assert.equal(callback.status,502);
    const body=await callback.json();
    assert.equal(body.error,'Provider response exceeded size limit');
    assert.equal((await (await fetch(base+'/api/session')).json()).connected,false);
  });
  it('rejects provider messages exceeding 1MB without reflecting their contents',async()=>{
    const base=await start(mockProvider({fullOversize:true})),{sid}=await oauth(base);
    const response=await fetch(base+'/api/mail/messages/m1',{headers:{Cookie:sid}});
    assert.equal(response.status,502);
    const body=await response.text();
    assert.ok(!body.includes('x'.repeat(100)));
    assert.ok(body.includes('size limit'));
  });
  it('bounds recursive MIME traversal and safely handles implausible timestamps',async()=>{
    let deep={mimeType:'text/plain',body:{data:Buffer.from('too-deep').toString('base64url')}};
    for(let i=0;i<20;i++)deep={mimeType:'multipart/mixed',parts:[deep]};
    const base=await start(mockProvider({fullPayload:deep,listEntries:[{id:'m1'}]})),{sid}=await oauth(base);
    const detail=await (await fetch(base+'/api/mail/messages/m1',{headers:{Cookie:sid}})).json();
    assert.ok(detail.body.includes('No plain-text body'));
    const list=await (await fetch(base+'/api/mail/messages?limit=1',{headers:{Cookie:sid}})).json();
    assert.equal(list.messages[0].date,'1970-01-01T00:00:00.000Z');
  });
  it('rejects invalid provider message IDs instead of requesting arbitrary paths',async()=>{
    const base=await start(mockProvider({listEntries:[{id:'../../../bad'},{id:'m1'}]})),{sid}=await oauth(base);
    const list=await (await fetch(base+'/api/mail/messages',{headers:{Cookie:sid}})).json();
    assert.equal(list.messages.length,1);
    assert.equal(list.messages[0].id,'m1');
  });
  it('limits per-session Gmail API request rates',async()=>{
    const base=await start(mockProvider()),{sid}=await oauth(base);
    for(let i=0;i<30;i++){
      const response=await fetch(base+'/api/mail/messages?limit=1',{headers:{Cookie:sid}});
      assert.equal(response.status,200,'call '+i);
    }
    const excess=await fetch(base+'/api/mail/messages?limit=1',{headers:{Cookie:sid}});
    assert.equal(excess.status,429);
    const invalidCookie=await fetch(base+'/api/mail/messages?limit=1',{
      headers:{Cookie:'pm_session=garbage'}
    });
    assert.equal(invalidCookie.status,401);
  });
});
