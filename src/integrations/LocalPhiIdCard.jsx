import { useEffect, useState } from 'react';
import { CheckCircle2, Fingerprint, LogIn, LogOut, ShieldCheck, XCircle } from 'lucide-react';
import './local-identity.css';

async function readSession(){
  const response=await fetch('/api/identity/session',{method:'GET',credentials:'same-origin',cache:'no-store'});
  const value=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(value.error==='phiid_local_lab_disabled'?
    'The local PhiID lab is not enabled. See the R2 setup guide.' :
    value.error||'Local identity bridge unavailable.');
  return value;
}

/** Dev-only PhiMail RP: no tokens, claims or cookies exposed to React. */
export default function LocalPhiIdCard(){
  const [status,setStatus]=useState(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(true);
  async function refresh(){
    setBusy(true);setError('');
    try{setStatus(await readSession());}
    catch(e){setStatus(null);setError(e.message);}
    finally{setBusy(false);}
  }
  useEffect(()=>{void refresh();},[]);
  async function logout(){
    setBusy(true);setError('');
    try{
      const response=await fetch('/api/identity/logout',{
        method:'POST',credentials:'same-origin',
        headers:{'X-PhiMail-Action':'logout'}
      });
      if(!response.ok)throw new Error('Local session logout was not accepted.');
      await refresh();
    }catch(e){setError(e.message);setBusy(false);}
  }
  return <section className="identity-card" aria-label="Verified local PhiID sign-in pilot">
    <div className="identity-card-left"><span className="identity-card-mark"><Fingerprint size={23}/></span><div><span className="identity-eyebrow">R2 · VERIFIED LOCAL DEVELOPMENT LOGIN</span><h3>PhiID via Keycloak</h3><p>A separate PhiMail OIDC client to the PhiID development realm. No shared cookies, borrowed tokens, or automatic mailbox permissions.</p></div></div>
    <div className="identity-card-state">
      {busy?<span className="identity-muted">Checking local session…</span>
      :status?.authenticated?<><div className="identity-ok"><CheckCircle2 size={17}/> Verified local OIDC session</div><strong>{status.preferred_username||'Development account'}</strong><small>Issuer: {status.issuer}</small><small>Subject: {status.sub}</small><small>No mail link · No cloud grants · No PhiOS authority</small><button onClick={logout} className="identity-secondary"><LogOut size={16}/> End PhiMail session</button></>
      :status?.enabled?<><span className="identity-muted"><ShieldCheck size={16}/> No active PhiMail identity session</span><a className="identity-login" href="/auth/phiid/start"><LogIn size={16}/> Sign in via local PhiID realm</a></>
      :<><span className="identity-muted"><XCircle size={16}/> Local lab offline or disabled</span><button className="identity-secondary" onClick={refresh}>Check again</button></>}
      {error&&<span className="identity-error" role="status">{error}</span>}
    </div>
  </section>;
}
