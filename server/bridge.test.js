import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from './bridge.js';

const ENV = {
  GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'server-only-test-secret',
  BRIDGE_PUBLIC_ORIGIN: 'http://localhost:5173'
};
const live = [];
afterEach(async () => {
  for (const server of live.splice(0)) await new Promise(resolve => server.close(resolve));
});
async function setup(overrides = {}, mock = undefined) {
  const server = createBridge({ env: { ...ENV, ...overrides }, fetchImpl: mock || (async () => { throw new Error('Unexpected network request'); }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  live.push(server);
  return 'http://127.0.0.1:' + server.address().port;
}
async function authenticate(base, fakeProvider) {
  const start = await fetch(base+'/auth/google/start',{redirect:'manual'});
  assert.equal(start.status,302);
  const destination = new URL(start.headers.get('location'));
  assert.equal(destination.hostname,'accounts.google.com');
  assert.equal(destination.searchParams.get('code_challenge_method'),'S256');
  assert.equal(destination.searchParams.get('redirect_uri'),'http://localhost:5173/auth/google/callback');
  const oauthCookie = start.headers.get('set-cookie').split(';')[0];
  const callback = await fetch(base+'/auth/google/callback?code=one-time-code&state='+destination.searchParams.get('state'),{
    headers:{Cookie:oauthCookie},redirect:'manual'
  });
  assert.equal(callback.status,302);
  assert.equal(callback.headers.get('location'),'http://localhost:5173/?phimail=connected');
  const cookieHeader=callback.headers.get('set-cookie');
  const sessionCookie=cookieHeader.match(/pm_session=[^;]+/)?.[0];
  assert.ok(sessionCookie);
  return sessionCookie;
}

describe('PhiMail experimental bridge', () => {
  it('advertises provider capabilities without declaring false connections', async () => {
    const base=await setup({ GOOGLE_CLIENT_ID:'',GOOGLE_CLIENT_SECRET:'' });
    const providers=await (await fetch(base+'/api/providers')).json();
    assert.equal(providers.providers[0].ready,false);
    assert.deepEqual(providers.providers[0].capabilities,['read:inbox','read:message']);
    assert.equal(providers.providers[1].ready,false);
    const start=await fetch(base+'/auth/google/start',{redirect:'manual'});
    assert.equal(start.status,503);
    assert.equal((await (await fetch(base+'/api/session')).json()).connected,false);
  });
  it('rejects unsolicited and mismatched OAuth callbacks', async () => {
    const base=await setup();
    const missing=await fetch(base+'/auth/google/callback?code=bad&state=bad',{redirect:'manual'});
    assert.equal(missing.status,400);
    const start=await fetch(base+'/auth/google/start',{redirect:'manual'});
    const cookie=start.headers.get('set-cookie').split(';')[0];
    const invalid=await fetch(base+'/auth/google/callback?code=bad&state=not-the-real-state',{headers:{Cookie:cookie},redirect:'manual'});
    assert.equal(invalid.status,400);
  });
  it('authenticates server-side and fetches Gmail inbox without exposing bearer tokens to clients', async () => {
    const visits=[];
    const mock=async (url,options={})=>{
      visits.push({url:String(url),header:options.headers?.Authorization || null});
      if(String(url).includes('/token')) return new Response(JSON.stringify({access_token:'secret-access-token',refresh_token:'secret-refresh-token',expires_in:3600}),{status:200});
      if(String(url).endsWith('/profile')) return new Response(JSON.stringify({emailAddress:'tester@gmail.com'}),{status:200});
      if(String(url).includes('/messages?')) return new Response(JSON.stringify({messages:[{id:'abc123'}]}),{status:200});
      if(String(url).includes('format=metadata')) return new Response(JSON.stringify({
        id:'abc123',threadId:'thread1',snippet:'Hello from Gmail',internalDate:'1760000000000',labelIds:['UNREAD','INBOX'],
        payload:{headers:[{name:'From',value:'Friend <friend@example.org>'},{name:'Subject',value:'Gmail pilot'}]}
      }),{status:200});
      if(String(url).includes('format=full')) return new Response(JSON.stringify({
        id:'abc123',threadId:'thread1',internalDate:'1760000000000',labelIds:['INBOX'],snippet:'Hello',
        payload:{mimeType:'multipart/alternative',headers:[{name:'From',value:'Friend <friend@example.org>'},{name:'Subject',value:'Gmail pilot'}],
          parts:[{mimeType:'text/plain',body:{data:Buffer.from('A safe plain text body').toString('base64url')}},{mimeType:'text/html',body:{data:Buffer.from('<img src="https://tracker.example/pixel">').toString('base64url')}}]}
      }),{status:200});
      throw new Error('Unexpected fake fetch URL: '+url);
    };
    const base=await setup({},mock);
    const sessionCookie=await authenticate(base);
    const session=await (await fetch(base+'/api/session',{headers:{Cookie:sessionCookie}})).json();
    assert.equal(session.connected,true);
    assert.equal(session.email,'tester@gmail.com');
    assert.ok(!JSON.stringify(session).includes('secret-access-token'));
    const listResponse=await fetch(base+'/api/mail/messages?limit=1',{headers:{Cookie:sessionCookie}});
    assert.equal(listResponse.status,200);
    const list=await listResponse.json();
    assert.equal(list.messages[0].subject,'Gmail pilot');
    assert.equal(list.messages[0].unread,true);
    const response=await fetch(base+'/api/mail/messages/abc123',{headers:{Cookie:sessionCookie}});
    assert.equal(response.status,200);
    const detail=await response.json();
    assert.equal(detail.body,'A safe plain text body');
    assert.ok(!JSON.stringify(detail).includes('tracker.example'));
    assert.ok(visits.some(x=>x.header==='Bearer secret-access-token'));
  });
  it('denies reads when unauthenticated and validates identifiers', async () => {
    const base=await setup();
    const unauth=await fetch(base+'/api/mail/messages');
    assert.equal(unauth.status,401);
    assert.equal((await fetch(base+'/api/no-such-endpoint')).status,404);
    assert.equal((await fetch(base+'/api/mail/messages',{method:'POST'})).status,404);
  });
  it('rejects cross-origin logout and clears the HttpOnly session on allowed origin', async () => {
    const mock=async url=>{
      if(String(url).includes('/token'))return new Response(JSON.stringify({access_token:'short-lived-token',expires_in:3600}),{status:200});
      return new Response(JSON.stringify({emailAddress:'pilot@gmail.com'}),{status:200});
    };
    const base=await setup({},mock);
    const sessionCookie=await authenticate(base);
    const malicious=await fetch(base+'/api/session/disconnect',{method:'POST',headers:{Cookie:sessionCookie,Origin:'https://malicious.example'}});
    assert.equal(malicious.status,403);
    const valid=await fetch(base+'/api/session/disconnect',{method:'POST',headers:{Cookie:sessionCookie,Origin:'http://localhost:5173'}});
    assert.equal(valid.status,200);
    assert.ok(valid.headers.get('set-cookie').includes('HttpOnly'));
    assert.equal((await (await fetch(base+'/api/session',{headers:{Cookie:sessionCookie}})).json()).connected,false);
  });
  it('refuses unreviewed production deployment and invalid HTTP origins', () => {
    assert.throws(()=>createBridge({env:{...ENV,NODE_ENV:'production'}}),/opt-in/);
    assert.throws(()=>createBridge({env:{...ENV,BRIDGE_PUBLIC_ORIGIN:'http://phi-field.com'}}),/HTTPS/);
    assert.throws(()=>createBridge({env:{...ENV,GOOGLE_REDIRECT_URI:'https://evil.example/callback'}}),/match/);
  });
});
