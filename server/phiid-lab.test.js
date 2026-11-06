import { request as rawRequest } from 'node:http';

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = rawRequest(new URL(url), {
      method: options.method || 'GET',
      headers: options.headers || {},
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          headers: {
            get: name => {
              const value = res.headers[name.toLowerCase()];
              return Array.isArray(value) ? value[0] : value ?? null;
            },
            getSetCookie: () => {
              const value = res.headers['set-cookie'];
              return Array.isArray(value) ? value : value ? [value] : [];
            }
          },
          json: async () => JSON.parse(raw)
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from './bridge.js';
import { DEV_CLIENT_ID, DEV_ISSUER, DEV_ORIGIN, validatedLocalProfile } from './phiid-lab.js';

const DEV_ENV = {
  BRIDGE_PUBLIC_ORIGIN: DEV_ORIGIN,
  PHIMAIL_LOCAL_PHIID:'1',
  GOOGLE_CLIENT_ID:'',
  GOOGLE_CLIENT_SECRET:'',
};
const running=[];
afterEach(async ()=>{
  for(const server of running.splice(0))await new Promise(resolve=>server.close(resolve));
});
function fakeProvider({subject='test-phiid-subject',fail=false}={}){
  return {
    async authorization(flow){
      const url=new URL(DEV_ISSUER+'/protocol/openid-connect/auth');
      url.searchParams.set('state',flow.state);
      return url.toString();
    },
    async exchange(_url,flow){
      if(fail)throw new Error('mock verification failed');
      return {iss:DEV_ISSUER,aud:DEV_CLIENT_ID,sub:subject,exp:Math.floor(Date.now()/1000)+600,
        preferred_username:'local-tester',nonce:flow.nonce};
    }
  };
}
async function createServer(options={}){
  const server=createBridge({
    env:{...DEV_ENV,...options.env},
    identityProvider:options.provider||fakeProvider(),
    fetchImpl:async()=>{throw new Error('Unexpected external provider request')}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  running.push(server);
  return 'http://127.0.0.1:'+server.address().port;
}
const BASE_HEADERS={Host:'127.0.0.1:5173'};
async function start(base){
  const res=await request(base+'/auth/phiid/start',{headers:BASE_HEADERS,redirect:'manual'});
  const destination=new URL(res.headers.get('location'));
  assert.equal(res.status,302);
  assert.equal(destination.origin,'http://127.0.0.1:8080');
  const flowCookie=res.headers.get('set-cookie')?.match(/pm_oidc_flow=[A-Za-z0-9_-]+/)?.[0];
  assert.ok(flowCookie);
  return {destination,flowCookie};
}
async function callback(base,flow,extras={}){
  const path='/auth/phiid/callback?code=local-code&state='+encodeURIComponent(flow.destination.searchParams.get('state'));
  return request(base+path,{headers:{...BASE_HEADERS,Cookie:flow.flowCookie,...extras},redirect:'manual'});
}

describe('PhiMail PhiID R2 lab',()=>{
 it('fails closed if opt-in missing',async()=>{
  const base=await createServer({env:{PHIMAIL_LOCAL_PHIID:''}});
  const response=await request(base+'/api/identity/session',{headers:BASE_HEADERS});
  assert.equal(response.status,503);
  assert.equal((await response.json()).authenticated,false);
 });
 it('rejects mismatched origin or public binding',async()=>{
  const base=await createServer({env:{BRIDGE_PUBLIC_ORIGIN:'http://localhost:5173'}});
  const r=await request(base+'/auth/phiid/start',{headers:BASE_HEADERS,redirect:'manual'});
  assert.equal(r.status,503);
 });
 it('starts only a pinned development authorization endpoint',async()=>{
  const base=await createServer();
  const {destination}=await start(base);
  assert.equal(destination.pathname,'/realms/phiid-dev/protocol/openid-connect/auth');
 });
 it('rejects host mismatches and callback without flow',async()=>{
  const base=await createServer();
  const host=await request(base+'/api/identity/session');
  assert.equal(host.status,403);
  const forged=await request(base+'/auth/phiid/callback?code=a&state=b',{headers:BASE_HEADERS,redirect:'manual'});
  assert.equal(forged.status,400);
 });
 it('rejects tampered state and consumes attempted flow',async()=>{
  const base=await createServer();
  const flow=await start(base);
  const tamper=await request(base+'/auth/phiid/callback?code=x&state=altered',{headers:{...BASE_HEADERS,Cookie:flow.flowCookie},redirect:'manual'});
  assert.equal(tamper.status,400);
  assert.equal((await callback(base,flow)).status,400);
 });
 it('exposes only minimal verified session profile; no mail authority',async()=>{
  const base=await createServer();
  const flow=await start(base);
  const auth=await callback(base,flow);
  assert.equal(auth.status,302);
  assert.equal(auth.headers.get('location'),DEV_ORIGIN+'/?phiid=connected');
  const identityCookie=auth.headers.getSetCookie().join(';').match(/pm_identity=[A-Za-z0-9_-]+/)?.[0];
  assert.ok(identityCookie);
  const identity=await request(base+'/api/identity/session',{headers:{...BASE_HEADERS,Cookie:identityCookie}});
  assert.equal(identity.status,200);
  const profile=await identity.json();
  assert.equal(profile.authenticated,true);
  assert.equal(profile.issuer,DEV_ISSUER);
  assert.equal(profile.sub,'test-phiid-subject');
  assert.equal(profile.mailbox_linked,false);
  assert.equal(profile.cloud_authorized,false);
  assert.deepEqual(profile.grants,[]);
  assert.ok(!JSON.stringify(profile).includes('local-code'));
  const gmail=await request(base+'/api/mail/messages',{headers:{...BASE_HEADERS,Cookie:identityCookie}});
  assert.equal(gmail.status,401); // OIDC is NOT a Gmail grant
  const csrf=await request(base+'/api/identity/logout',{method:'POST',headers:{...BASE_HEADERS,Cookie:identityCookie,Origin:'https://malicious.example','X-PhiMail-Action':'logout'}});
  assert.equal(csrf.status,403);
  const logout=await request(base+'/api/identity/logout',{method:'POST',headers:{...BASE_HEADERS,Cookie:identityCookie,Origin:DEV_ORIGIN,'X-PhiMail-Action':'logout'}});
  assert.equal(logout.status,200);
  const again=await (await request(base+'/api/identity/session',{headers:{...BASE_HEADERS,Cookie:identityCookie}})).json();
  assert.equal(again.authenticated,false);
 });
 it('does not establish a session on failed provider validation',async()=>{
  const base=await createServer({provider:fakeProvider({fail:true})});
  const flow=await start(base);
  const res=await callback(base,flow);
  assert.equal(res.status,401);
  assert.equal(res.headers.getSetCookie().some(cookie=>cookie.startsWith('pm_identity=')),false);
 });
 it('refuses unsafe fake provider redirect destinations',async()=>{
  const base=await createServer({provider:{
    async authorization(){return 'https://malicious.example/login';},
    async exchange(){throw Error('should never exchange');}
  }});
  const res=await request(base+'/auth/phiid/start',{headers:BASE_HEADERS,redirect:'manual'});
  assert.equal(res.status,503);
 });
 it('rejects invalid identity claims even after a claimed exchange',()=>{
  const claims={iss:DEV_ISSUER,aud:DEV_CLIENT_ID,sub:'ok',exp:Math.floor(Date.now()/1000)+60};
  assert.equal(validatedLocalProfile(claims).authenticated,true);
  assert.throws(()=>validatedLocalProfile({...claims,aud:'other-client'}));
  assert.throws(()=>validatedLocalProfile({...claims,iss:'https://attacker.example'}));
  assert.throws(()=>validatedLocalProfile({...claims,exp:0}));
  assert.throws(()=>validatedLocalProfile({...claims,sub:''}));
 });
});
