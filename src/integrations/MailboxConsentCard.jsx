import {useEffect,useState} from 'react';
import {CheckCircle2,CircleAlert,Fingerprint,LockKeyhole,Mail,RefreshCw,ShieldCheck,XCircle} from 'lucide-react';
import './mailbox-consent.css';

const SCHEMA='phimail.local-mailbox-consent/v0.1';
const ROOT='/api/identity/mailbox-consent';
async function request(path='',{action,body}={}){
  const response=await fetch(ROOT+path,{
    method:action?'POST':'GET',cache:'no-store',credentials:'same-origin',
    headers:action?{'Content-Type':'application/json','X-PhiMail-Action':action}:{},
    ...(body?{body:JSON.stringify(body)}:{})
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||'Local consent service unavailable');
  return data;
}
export default function MailboxConsentCard({onOpenOutlook}){
  const [state,setState]=useState(null);
  const [intent,setIntent]=useState(null);
  const [ack,setAck]=useState(false);
  const [busy,setBusy]=useState(true);
  const [error,setError]=useState('');
  async function refresh(){
    setBusy(true);setError('');setIntent(null);setAck(false);
    try{setState(await request());}
    catch(e){setState(null);setError(e.message);}
    finally{setBusy(false);}
  }
  useEffect(()=>{void refresh();},[]);
  async function begin(){
    setBusy(true);setError('');setIntent(null);setAck(false);
    try{
      const result=await request('/intent',{
        action:'begin-mailbox-consent',
        body:{schema:SCHEMA,provider:'outlook',capabilities:['read:inbox','read:message']}
      });
      setIntent(result.intent);
    }catch(e){setError(e.message);}
    finally{setBusy(false);}
  }
  async function approve(){
    if(!ack||!intent)return;
    const current=intent;
    setBusy(true);setError('');setIntent(null);setAck(false);
    try{
      await request('/approve',{
        action:'approve-mailbox-consent',
        body:{schema:SCHEMA,intentId:current.id,
          challenge:current.challenge,acknowledged:true}
      });
      setState(await request());
    }catch(e){setError(e.message);}
    finally{setBusy(false);}
  }
  async function revoke(){
    setBusy(true);setError('');setIntent(null);setAck(false);
    try{
      await request('/revoke',{
        action:'revoke-mailbox-consent',body:{schema:SCHEMA}
      });
      setState(await request());
    }catch(e){setError(e.message);}
    finally{setBusy(false);}
  }
  return <section className="phimail-consent-card" aria-label="Temporary Outlook consent laboratory">
    <div className="phimail-consent-header">
      <div>
        <span className="phimail-consent-overline">R13 · EXPLICIT LOCAL CONSENT</span>
        <h3>Outlook ownership approval lab</h3>
        <p>Verify two independently connected sessions, review the exact account, and deliberately approve a temporary read-only association.</p>
      </div>
      <button type="button" onClick={refresh} disabled={busy} title="Refresh consent state" aria-label="Refresh consent state"><RefreshCw size={16}/></button>
    </div>
    <div className="phimail-consent-states">
      <span><Fingerprint size={15}/> PhiID: <b>{state?.identity_verified?'Verified local session':'Not verified'}</b></span>
      <span><Mail size={15}/> Outlook: <b>{state?.outlook_verified?'Graph account verified':'Not verified'}</b></span>
    </div>
    {state?.owner&&<p className="phimail-consent-data">PhiID subject: {state.owner.subject}</p>}
    {state?.mailbox&&<p className="phimail-consent-data">Outlook account ID: {state.mailbox.accountId}</p>}
    {busy&&<p className="phimail-consent-note">Checking verified local sessions…</p>}
    {error&&<p className="phimail-consent-error" role="alert"><CircleAlert size={16}/>{error}</p>}
    {!busy&&!state&&<p className="phimail-consent-note">Requires the exact loopback development bridge, PhiID local login and an authorized Outlook personal-account pilot. No live account is linked by this card.</p>}
    {!busy&&state&&!state.eligible_to_request_consent&&<div className="phimail-consent-actions">
      {!state.identity_verified&&<a href="/auth/phiid/start">Sign in to local PhiID</a>}
      {!state.outlook_verified&&<button type="button" onClick={onOpenOutlook}>Open Outlook read-only pilot</button>}
    </div>}
    {!busy&&state?.grant&&<div className="phimail-consent-record">
      <CheckCircle2 size={19}/>
      <div>
        <strong>Temporary local approval recorded</strong>
        <p>Expires {new Date(state.grant.expires_at).toLocaleString()}. This authorizes no additional live mailbox reads, does not create a persistent account link, and does not persist credentials.</p>
        <button type="button" onClick={revoke}><XCircle size={15}/> Revoke this owner's local approvals</button>
      </div>
    </div>}
    {!busy&&state?.eligible_to_request_consent&&!state.grant&&!intent&&
      <div className="phimail-consent-actions">
        <button type="button" onClick={begin}><ShieldCheck size={15}/> Review temporary read-only approval</button>
      </div>}
    {!busy&&intent&&<div className="phimail-consent-approval">
      <strong>Review before approving</strong>
      <p>Provider: <b>Outlook personal account</b></p>
      <p>Verified account: <b>{intent.mailbox.accountId}</b></p>
      <p>Requested read-only scopes: <b>{intent.capabilities.join(', ')}</b></p>
      <p>One-time challenge expires {new Date(intent.expires_at).toLocaleString()}.</p>
      <label><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/>
        <span>I explicitly approve a temporary local PhiID-to-Outlook read-only grant for the displayed account and scopes. I understand this does not connect accounts permanently, add live mailbox permissions, or store secrets.</span>
      </label>
      <div className="phimail-consent-actions">
        <button type="button" onClick={approve} disabled={!ack}><ShieldCheck size={15}/> Approve once</button>
        <button type="button" onClick={()=>{setIntent(null);setAck(false);}} className="quiet">Cancel</button>
      </div>
    </div>}
    <footer className="phimail-consent-footer"><LockKeyhole size={14}/> Local-only · 5-minute approval window · 15-minute maximum grant · No new mailbox authority or remote revocation</footer>
  </section>;
}
