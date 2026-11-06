import { useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, Fingerprint, Link2Off, Mail, RefreshCw, ShieldCheck } from 'lucide-react';
import './mailbox-review.css';

const SCHEMA='phimail.local-mailbox-review/0.1';
async function api(method,body,action){
  const response=await fetch('/api/identity/mailbox-review',{
    method,credentials:'same-origin',cache:'no-store',
    headers:{
      ...(method==='POST'?{'Content-Type':'application/json'}:{}),
      ...(action?{'X-PhiMail-Action':action}:{})
    },
    ...(body?{body:JSON.stringify(body)}:{})
  });
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(payload.error||'Local review endpoint unavailable');
  return payload;
}

export default function MailboxReviewCard({onOpenGmail}){
  const [state,setState]=useState(null);
  const [ack,setAck]=useState(false);
  const [busy,setBusy]=useState(true);
  const [error,setError]=useState('');

  async function refresh(){
    setBusy(true);setError('');setAck(false);
    try{setState(await api('GET'));}
    catch(e){setState(null);setError(e.message);}
    finally{setBusy(false);}
  }
  useEffect(()=>{void refresh();},[]);
  async function review(){
    setBusy(true);setError('');
    try{
      const updated=await api('POST',{schema:SCHEMA,provider:'gmail',acknowledged:true},'review-mailbox');
      setState(updated);setAck(false);
    }catch(e){setError(e.message);}
    finally{setBusy(false);}
  }
  async function clear(){
    setBusy(true);setError('');
    try{setState(await api('DELETE',null,'clear-review'));setAck(false);}
    catch(e){setError(e.message);}
    finally{setBusy(false);}
  }

  return <section className="mailbox-review" aria-label="Experimental mailbox association review">
    <div className="mailbox-review-head">
      <div><span className="mailbox-review-overline">R3 · CONSENT-TO-REVIEW LAB</span>
        <h3>Mailbox association review</h3>
        <p>Two independent sessions. One explicit choice. <strong>No mailbox account is actually linked.</strong></p>
      </div>
      <button className="mailbox-review-icon" onClick={refresh} disabled={busy} aria-label="Refresh review status"><RefreshCw size={17}/></button>
    </div>
    <div className="mailbox-review-parties">
      <div className="mailbox-review-party">
        <Fingerprint size={20}/><div><strong>PhiID identity</strong>
          {state?.authenticated_identity?<><span>{state.identity.preferred_username||'Local test user'}</span><small>{state.identity.issuer}</small><small>Subject: {state.identity.sub}</small></>
            :<span>Verified local sign-in required</span>}</div>
        <i className={state?.authenticated_identity?'active':''}/>
      </div>
      <div className="mailbox-review-party">
        <Mail size={20}/><div><strong>Gmail OAuth mailbox</strong>
          <span>{state?.connected_gmail_session?state.mailbox.email:'Read-only Gmail connection required'}</span>
          <small>Separate provider authorization · no implicit PhiID association</small></div>
        <i className={state?.connected_gmail_session?'active':''}/>
      </div>
    </div>
    {busy&&<span className="mailbox-review-muted">Checking local sessions…</span>}
    {error&&<p className="mailbox-review-error" role="alert"><CircleAlert size={16}/>{error}</p>}
    {!busy&&state&&!state.eligible_to_review&&<div className="mailbox-review-prompt">
      {!state.authenticated_identity&&<a href="/auth/phiid/start">Sign in to local PhiID first</a>}
      {!state.connected_gmail_session&&<button onClick={onOpenGmail}>Open Gmail read-only pilot</button>}
      <small>Both sessions must be active in this same local PhiMail browser session.</small>
    </div>}
    {!busy&&state?.eligible_to_review&&!state.review&&<div className="mailbox-review-action">
      <label><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/>
        <span>I reviewed the displayed PhiID test identity and Gmail account. I understand this only records my temporary choice, grants no mail or cloud permissions, and does not create a persistent account link.</span>
      </label>
      <button disabled={!ack} onClick={review}><ShieldCheck size={16}/> Record local review (no linking)</button>
    </div>}
    {!busy&&state?.review&&<div className="mailbox-review-record">
      <div><CheckCircle2 size={18}/><strong>Review recorded in this local session</strong></div>
      <p>This temporary receipt expires {new Date(state.review.expires_at).toLocaleString()}. It is not enforced and does not grant access.</p>
      <button onClick={clear}><Link2Off size={16}/> Clear review receipt</button>
    </div>}
    <footer className="mailbox-review-foot">Actual account linked: <b>No</b> · New mail permission: <b>None</b> · PhiCloud authorization: <b>None</b></footer>
  </section>;
}
