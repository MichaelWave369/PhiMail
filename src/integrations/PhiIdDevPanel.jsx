import { useEffect, useState } from 'react';
import { Fingerprint, LogIn, LogOut, ShieldCheck, TriangleAlert } from 'lucide-react';
import './phiid-dev.css';

/**
 * Strictly local / dev-only OIDC RP. Independent from Gmail access and
 * independent from the synthetic PhiID export inspector.
 */
export default function PhiIdDevPanel() {
  const [profile,setProfile]=useState(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);

  useEffect(()=>{
    if (!import.meta.env.DEV) return;
    let alive=true;
    fetch('/api/phiid/session',{credentials:'same-origin',cache:'no-store'})
      .then(async response=>{
        if(!response.ok)throw Error('Local identity bridge unavailable');
        return response.json();
      })
      .then(data=>{if(alive)setProfile(data);})
      .catch(()=>{if(alive)setError('Start the PhiMail local bridge to inspect PhiID sign-in status.');});
    return()=>{alive=false;};
  },[]);

  async function disconnect(){
    setBusy(true);setError('');
    try {
      const res=await fetch('/api/phiid/logout',{method:'POST',credentials:'same-origin',
        headers:{'X-PhiMail-Action':'phiid-logout'}});
      if(!res.ok)throw Error('Local identity logout failed');
      setProfile({enabled:true,authenticated:false,capabilities:[],mailbox_connected:false,phios_authority:false});
    }catch{setError('Unable to clear the PhiMail local identity session.');}
    finally{setBusy(false);}
  }

  if(!import.meta.env.DEV)return null;
  return <div className="phiid-rp-lab">
    <div className="phiid-rp-heading"><Fingerprint size={18}/><strong>PhiID sign-in · localhost lab</strong></div>
    <p>Separate OpenID Connect client using the PhiID Keycloak development realm. It cannot connect Gmail, read mail, use PhiCloud or control PhiOS.</p>
    {error&&<div className="phiid-rp-error" role="alert"><TriangleAlert size={14}/>{error}</div>}
    {profile?.enabled===false&&<div className="phiid-rp-note">Not enabled. Set <code>PHIMAIL_ENABLE_PHIID_DEV=1</code> in your private local bridge configuration.</div>}
    {profile?.enabled && !profile.authenticated && <div>
      <div className="phiid-rp-note">Not authenticated. No permissions.</div>
      <a className="phiid-rp-button" href="/auth/phiid/start"><LogIn size={16}/> Sign in to local PhiID</a>
    </div>}
    {profile?.enabled && profile.authenticated && <div className="phiid-rp-verified">
      <div className="phiid-rp-status"><ShieldCheck size={15}/> Verified local OIDC identity · no authority</div>
      <dl><dt>Display</dt><dd>{profile.display_name||'Local user'}</dd>
        <dt>Subject</dt><dd>{profile.subject}</dd>
        <dt>Issuer</dt><dd>{profile.issuer}</dd>
        <dt>Mailbox access</dt><dd>None from PhiID</dd>
        <dt>PhiOS authority</dt><dd>None</dd></dl>
      <button type="button" className="phiid-rp-button" onClick={disconnect} disabled={busy}>
        <LogOut size={16}/>{busy?'Clearing local session…':'End PhiMail PhiID session'}</button>
      <small>Ending this session does not end the Keycloak SSO session or an independent Gmail session.</small>
    </div>}
    {!profile&&!error&&<div className="phiid-rp-note">Reading local identity status…</div>}
  </div>;
}
