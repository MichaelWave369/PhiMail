import { useEffect, useRef, useState } from 'react';
import { Cloud, FileUp, Fingerprint, Info, Layers3, LockKeyhole, RefreshCw, ShieldAlert, X } from 'lucide-react';
import { inspectPhiIdPreviewExport, readLocalPhiCloudRegistry } from './contracts.js';
import './connections.css';

export default function FieldConnections({onClose}) {
  const [account,setAccount]=useState(null);
  const [accountError,setAccountError]=useState('');
  const [registry,setRegistry]=useState(null);
  const [registryError,setRegistryError]=useState('');
  const [busy,setBusy]=useState(false);
  const fileRef=useRef(null);
  useEffect(()=>{
    const handler=e=>{if(e.key==='Escape')onClose();};
    window.addEventListener('keydown',handler);
    return()=>window.removeEventListener('keydown',handler);
  },[onClose]);

  async function selectPreview(e){
    const file=e.target.files?.[0];e.target.value='';
    if(!file)return;
    setAccount(null);setAccountError('');
    try {
      if(file.size>16384)throw new Error('Preview export exceeds 16 KB');
      setAccount(inspectPhiIdPreviewExport(JSON.parse(await file.text())));
    } catch(error){setAccountError('Preview rejected: '+error.message);}
  }
  async function readRegistry(){
    setBusy(true);setRegistryError('');setRegistry(null);
    try{setRegistry(await readLocalPhiCloudRegistry());}
    catch(error){setRegistryError(error.message);}
    finally{setBusy(false);}
  }

  return <div className="field-veil" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}>
    <section className="field-window" role="dialog" aria-modal="true" aria-labelledby="field-heading">
      <header className="field-head"><span className="field-brand"><Layers3 size={22}/></span><div><small>Φ ECOSYSTEM · R1</small><h2 id="field-heading">Field Connections</h2></div><span className="field-label">CONTRACT PREVIEW</span><button aria-label="Close Field Connections" onClick={onClose}><X size={20}/></button></header>
      <div className="field-warning"><Info size={17}/><span>Read-only integration preview. <b>Nothing here signs in a user, connects a real account, confirms service health or grants permissions.</b></span></div>
      <div className="field-columns">
        <section className="field-card">
          <div className="field-card-head"><span className="field-card-icon"><Fingerprint size={21}/></span><div><strong>PhiID</strong><small>phi-account/0.1 · identity metadata</small></div></div>
          <div className="field-status">Not authenticated · no permissions</div>
          <p>Inspect a synthetic PhiID export. This checks the shared format but does not prove ownership of any identity.</p>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={selectPreview} aria-label="Choose synthetic PhiID export"/>
          <button className="field-action" onClick={()=>fileRef.current?.click()}><FileUp size={17}/> Inspect PhiID preview JSON</button>
          {accountError&&<div className="field-error" role="alert"><ShieldAlert size={16}/>{accountError}</div>}
          {account&&<div className="field-result"><b>Schema compatible · display only</b>
            <dl><dt>Display name</dt><dd>{account.preferredUsername}</dd><dt>Issuer, unverified</dt><dd>{account.issuer}</dd><dt>Subject, unverified</dt><dd>{account.subject}</dd><dt>Authenticated</dt><dd>No</dd><dt>Permissions</dt><dd>None</dd></dl>
            <button className="field-clear" onClick={()=>setAccount(null)}>Clear from memory</button>
          </div>}
          <a href="https://github.com/MichaelWave369/PhiID" target="_blank" rel="noopener noreferrer">PhiID source and export instructions</a>
        </section>
        <section className="field-card">
          <div className="field-card-head"><span className="field-card-icon cloud"><Cloud size={21}/></span><div><strong>PhiCloud</strong><small>phicloud.services.v0.1 · service declarations</small></div></div>
          <div className="field-status">No service health checked</div>
          <p>Read the local PhiCloud service registry without probing individual services or using advertised endpoint hints.</p>
          {import.meta.env.DEV
            ? <button className="field-action" disabled={busy} onClick={readRegistry}><RefreshCw size={17}/>{busy?'Reading local registry…':'Read local PhiCloud registry'}</button>
            : <div className="field-disabled"><LockKeyhole size={16}/> Available only in the local developer build.</div>}
          {registryError&&<div className="field-error" role="alert"><ShieldAlert size={16}/>{registryError} · Start the PhiCloud server on 127.0.0.1:8769.</div>}
          {registry&&<div className="field-result"><b>Registry responded · not service health</b>
            <div className="field-service-list">{registry.services.map(s=><div className="field-service" key={s.id}><span><strong>{s.title}</strong><small>{s.role}</small></span><em>{s.declaredStage.replaceAll('-',' ')}</em></div>)}</div>
            <small>All individual health states remain unverified. No access was granted.</small>
          </div>}
          <a href="https://github.com/MichaelWave369/PhiCloud" target="_blank" rel="noopener noreferrer">PhiCloud source and registry instructions</a>
        </section>
      </div>
      <footer className="field-foot"><LockKeyhole size={16}/> PhiOS remains usable offline. These adapters grant zero authority.</footer>
    </section>
  </div>;
}
