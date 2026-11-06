import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createBridge } from './bridge.js';
import { assertPhiIdProviderMetadata, assertPhiIdLocalRequest, createPhiIdDevAdapter } from './phiid-dev.js';

const ISSUER='http://127.0.0.1:8080/realms/phiid-dev';
const META = {
  issuer:ISSUER,
  authorization_endpoint:ISSUER+'/protocol/openid-connect/auth',
  token_endpoint:ISSUER+'/protocol/openid-connect/token',
  jwks_uri:ISSUER+'/protocol/openid-connect/certs',
};

describe('PhiMail independent PhiID local OIDC contract', () => {
  it('pins the issuer and every remote provider endpoint', () => {
    assert.equal(assertPhiIdProviderMetadata(META),true);
    const broken=[
      {...META,issuer:'http://evil.invalid'},
      {...META,authorization_endpoint:'http://evil.invalid/auth'},
      {...META,token_endpoint:'http://localhost:8080/realms/phiid-dev/protocol/openid-connect/token'},
      {...META,jwks_uri:'http://127.0.0.1:8081/realms/phiid-dev/protocol/openid-connect/certs'},
      {...META,jwks_uri:META.jwks_uri+'?override=1'},
      {...META,token_endpoint:'https://127.0.0.1:8080/realms/phiid-dev/protocol/openid-connect/token'},
    ];
    for(const entry of broken) assert.throws(()=>assertPhiIdProviderMetadata(entry));
  });

  it('permits only loopback Vite proxy traffic, not cross-site browser requests', () => {
    const req={headers:{host:'localhost:5173','sec-fetch-site':'same-origin'},
      socket:{remoteAddress:'127.0.0.1'}};
    assert.equal(assertPhiIdLocalRequest(req),true);
    assert.equal(assertPhiIdLocalRequest({...req,headers:{...req.headers,host:'127.0.0.1:8787'}}),false);
    assert.equal(assertPhiIdLocalRequest({...req,headers:{...req.headers,'sec-fetch-site':'cross-site'}}),false);
    assert.equal(assertPhiIdLocalRequest({...req,socket:{remoteAddress:'192.168.1.20'}}),false);
  });

  it('is disabled by default and rejects accidental production activation', () => {
    assert.equal(createPhiIdDevAdapter({env:{NODE_ENV:'development'}}).enabled,false);
    assert.throws(()=>createPhiIdDevAdapter({
      env:{PHIMAIL_ENABLE_PHIID_DEV:'1',NODE_ENV:'production'}
    }),/never run in production/);
  });
});

const servers=[];
afterEach(async()=>{ for(const s of servers.splice(0)) await new Promise(r=>s.close(r)); });

async function runBridge(enabled){
  const srv=createBridge({env:{
    NODE_ENV:'test',
    BRIDGE_PUBLIC_ORIGIN:'http://localhost:5173',
    GOOGLE_CLIENT_ID:'',GOOGLE_CLIENT_SECRET:'',
    PHIMAIL_ENABLE_PHIID_DEV:enabled?'1':'0',
  },fetchImpl:async()=>{throw Error('unexpected provider network');}});
  await new Promise(resolve=>srv.listen(0,'127.0.0.1',resolve));
  servers.push(srv);
  return srv.address().port;
}

function request(port,path,{method='GET',headers={}}={}){
  return new Promise((resolve,reject)=>{
    const req=httpRequest({hostname:'127.0.0.1',port,path,method,headers:{
      host:'localhost:5173',...headers
    }},res=>{
      const body=[];
      res.on('data',b=>body.push(b));
      res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(body).toString(),
        headers:res.headers}));
    });
    req.on('error',reject);req.end();
  });
}

describe('PhiMail dev bridge OIDC routes',()=>{
  it('off by default, leaving the existing Gmail endpoints usable',async()=>{
    const port=await runBridge(false);
    const id=await request(port,'/api/phiid/session');
    assert.equal(id.status,200);
    assert.deepEqual(JSON.parse(id.body),{
      enabled:false,authenticated:false,environment:'dev_only'
    });
    const start=await request(port,'/auth/phiid/start');
    assert.equal(start.status,404);
    const gmail=await request(port,'/api/session');
    assert.equal(gmail.status,200);
    assert.equal(JSON.parse(gmail.body).connected,false);
  });
  it('refuses forged hosts and missing sessions, without contacting Keycloak',async()=>{
    const port=await runBridge(true);
    const stranger=await request(port,'/api/phiid/session',{headers:{host:'evil.invalid:5173'}});
    assert.equal(stranger.status,403);
    const anon=await request(port,'/api/phiid/session');
    assert.equal(anon.status,200);
    assert.deepEqual(JSON.parse(anon.body),{
      enabled:true,authenticated:false,environment:'dev_only',
      capabilities:[],mailbox_connected:false,phios_authority:false,
    });
    const callback=await request(port,'/auth/phiid/callback?state=x&code=y');
    assert.equal(callback.status,400);
    assert.equal(JSON.parse(callback.body).error,'missing_or_expired_oidc_flow');
    const blocked=await request(port,'/api/phiid/logout',{method:'POST',
      headers:{origin:'https://evil.invalid','x-phimail-action':'phiid-logout'}});
    assert.equal(blocked.status,403);
    const logout=await request(port,'/api/phiid/logout',{method:'POST',
      headers:{origin:'http://localhost:5173','x-phimail-action':'phiid-logout'}});
    assert.equal(logout.status,200);
    assert.equal(JSON.parse(logout.body).authenticated,false);
    const gmail=await request(port,'/api/session');
    assert.equal(JSON.parse(gmail.body).connected,false);
  });
});
