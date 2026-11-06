import { describe, expect, it } from 'vitest';
import { inspectPhiIdPreviewExport, inspectPhiCloudRegistry, readLocalPhiCloudRegistry } from './contracts.js';

const ACCOUNT = {
 schema_version:'phi-account/0.1',
 issuer:'https://example.invalid/phiid',
 sub:'demo-subject-369-not-an-account',
 preferred_username:'field-explorer',
 email:null,
 email_verified:false
};
const EXPORT={kind:'phiid-preview-export-only',authentic_identity_proof:false,warning:'Synthetic only.',account:ACCOUNT};
const REGISTRY={schema:'phicloud.services.v0.1',services:[
 {id:'phiid',title:'PhiID',role:'identity',stage:'planned',repository:null,endpoint_hint:null},
 {id:'phimail',title:'PhiMail',role:'mail',stage:'integration-needed',repository:'https://github.com/MichaelWave369/PhiMail',endpoint_hint:null}
]};

describe('PhiID preview consumer boundary',()=>{
 it('accepts canonical PhiID synthetic export but never authenticates',()=>{
  const result=inspectPhiIdPreviewExport(EXPORT);
  expect(result.authenticated).toBe(false);
  expect(result.displayOnly).toBe(true);
  expect(result.permissions).toEqual([]);
  expect(result.principalKeyForDisplayOnly).toBe(JSON.stringify([ACCOUNT.issuer,ACCOUNT.sub]));
 });
 it('refuses a claimed real proof',()=>expect(()=>inspectPhiIdPreviewExport({...EXPORT,authentic_identity_proof:true})).toThrow());
 it('refuses unexpected identity and token fields',()=>{
  expect(()=>inspectPhiIdPreviewExport({...EXPORT, access_token:'fake'})).toThrow();
  expect(()=>inspectPhiIdPreviewExport({...EXPORT,account:{...ACCOUNT,roles:['admin']}})).toThrow();
 });
 it('rejects mismatched versions and unsafe issuers',()=>{
  expect(()=>inspectPhiIdPreviewExport({...EXPORT,account:{...ACCOUNT,schema_version:'phi-account/9.9'}})).toThrow();
  expect(()=>inspectPhiIdPreviewExport({...EXPORT,account:{...ACCOUNT,issuer:'http://localhost:4444'}})).toThrow();
 });
 it('does not trust verified email as a permission',()=>{
  const result=inspectPhiIdPreviewExport({...EXPORT,account:{...ACCOUNT,email:'example@example.test',email_verified:true}});
  expect(result.authenticated).toBe(false);
  expect(result.permissions).toHaveLength(0);
  expect(result.email).toBe('example@example.test');
 });
});

describe('PhiCloud registry consumer boundary',()=>{
 it('accepts service declarations but never labels them live',()=>{
  const data=inspectPhiCloudRegistry(REGISTRY);
  expect(data.registryReadSucceeded).toBe(true);
  expect(data.services.every(x=>x.liveHealth==='not-checked'&&x.authorized===false)).toBe(true);
  expect(data.services[1].declaredStage).toBe('integration-needed');
 });
 it('refuses extra authority fields and duplicate IDs',()=>{
  expect(()=>inspectPhiCloudRegistry({...REGISTRY,services:[{...REGISTRY.services[0],is_open:true}]})).toThrow();
  expect(()=>inspectPhiCloudRegistry({...REGISTRY,services:[REGISTRY.services[0],REGISTRY.services[0]]})).toThrow();
 });
 it('refuses untrusted URL hints and versions',()=>{
  expect(()=>inspectPhiCloudRegistry({...REGISTRY,schema:'phicloud.services.v0.2'})).toThrow();
  expect(()=>inspectPhiCloudRegistry({...REGISTRY,services:[{...REGISTRY.services[0],endpoint_hint:'http://10.1.1.1/admin'}]})).toThrow();
 });
 it('uses only fixed same-origin local proxy, never service endpoint hints',async()=>{
  const requests=[];
  const fake=async (url,options)=>{
    requests.push({url,options});
    return {ok:true,headers:{get:()=>null},text:async()=>JSON.stringify(REGISTRY)};
  };
  const result=await readLocalPhiCloudRegistry(fake);
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe('/field-registry/v1/services');
  expect(result.services[0].liveHealth).toBe('not-checked');
 });
 it('rejects oversized or invalid response safely',async()=>{
  const huge=async()=>({ok:true,headers:{get:()=>String(200000)},text:async()=>{throw Error('must not read');}});
  await expect(readLocalPhiCloudRegistry(huge)).rejects.toThrow(/large/);
 });
});
