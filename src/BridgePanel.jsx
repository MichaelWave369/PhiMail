import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CircleAlert, ExternalLink, Inbox, LockKeyhole, Mail, RefreshCw, ShieldCheck, X } from 'lucide-react';
import './bridge.css';

async function getJSON(path, options) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || 'Bridge request failed (' + response.status + ')');
  return json;
}

export default function BridgePanel({ onClose }) {
  const [session, setSession] = useState(null);
  const [providers, setProviders] = useState(null);
  const [messages, setMessages] = useState([]);
  const [selected, setSelected] = useState(null);
  const [messageBody, setMessageBody] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [messageError, setMessageError] = useState('');
  const [reachedLimit, setReachedLimit] = useState(false);

  const loadMailbox = useCallback(async () => {
    setBusy(true); setError(''); setSelected(null); setMessageBody(null);
    try {
      const data = await getJSON('/api/mail/messages?limit=15');
      setMessages(Array.isArray(data.messages) ? data.messages : []);
      setReachedLimit(Boolean(data.nextPageAvailable));
    } catch (cause) { setError(cause.message); setMessages([]); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [status, available] = await Promise.all([getJSON('/api/session'), getJSON('/api/providers')]);
        if (cancelled) return;
        setSession(status); setProviders(available);
        if (status.connected) await loadMailbox();
      } catch {
        if (!cancelled) {
          setSession({connected:false});
          setError('The PhiMail bridge is not running. Start npm run bridge:dev on localhost, then reopen this panel.');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [loadMailbox]);

  async function openMessage(item) {
    setSelected(item); setMessageBody(null); setReading(true); setMessageError('');
    try {
      const details = await getJSON('/api/mail/messages/' + encodeURIComponent(item.id));
      setMessageBody(details);
    } catch (cause) { setMessageError(cause.message); }
    finally { setReading(false); }
  }
  async function disconnect() {
    setBusy(true); setError('');
    try {
      await getJSON('/api/session/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      setSession({ connected: false }); setMessages([]); setSelected(null); setMessageBody(null);
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }

  const gmailReady = providers?.providers?.find(item => item.id === 'gmail')?.ready === true;
  return <div className="bridge-backdrop" role="presentation">
    <section className="bridge-window" role="dialog" aria-modal="true" aria-labelledby="bridge-title">
      <header className="bridge-head">
        <span className="bridge-title-mark">Φ</span>
        <div><div className="bridge-overline">PHIMAIL · RUNG 2A</div><h2 id="bridge-title">Gmail bridge pilot</h2></div>
        <span className="bridge-local-badge"><LockKeyhole size={13}/> LOCAL ONLY</span>
        <button className="bridge-icon-button bridge-close" aria-label="Close Gmail pilot" onClick={onClose}><X size={20}/></button>
      </header>
      <div className="bridge-notice"><ShieldCheck size={19}/><p><b>Experimental read-only connector.</b> Tokens remain in the bridge's server memory. No Gmail messages are saved in PhiMail browser storage, and sending, deleting or modifying real messages is not supported.</p></div>
      {providers?.providers&&<div className="bridge-provider-catalog" aria-label="Mail provider adapter availability">
        {providers.providers.map(item=><div key={item.id} className={'bridge-provider-item '+(item.ready?'is-ready':'')}>
          <span>{item.name||item.id}</span>
          <small>{item.ready?'Reader configured':item.id==='gmail'?'Setup required':'Not implemented'}</small>
        </div>)}
      </div>}

      {session===null ? <div className="bridge-center"><RefreshCw className="bridge-spin" size={30}/><p>Checking bridge connection…</p></div>
      : !session.connected ? <div className="bridge-center">
          <div className="bridge-hero-icon"><Mail size={34}/></div>
          <h3>Connect your Gmail inbox.</h3>
          <p>Read your own mailbox through Google OAuth without sharing your password with the React app.</p>
          <div className="bridge-steps"><span>1 · Start the local Node bridge</span><span>2 · Configure your Google OAuth test credentials</span><span>3 · Review Google's Gmail read-only consent screen</span></div>
          {gmailReady&&<a className="bridge-primary-link" href="/auth/google/start">Connect Gmail (read-only) <ExternalLink size={17}/></a>}
          {providers&&!gmailReady&&<span className="bridge-config-warn"><CircleAlert size={17}/> Google OAuth credentials are not configured on your bridge.</span>}
        </div>
      : <div className="bridge-connected">
          <div className="bridge-account"><div><span className="bridge-connected-dot"/> Connected as <strong>{session.email}</strong><span className="bridge-scope">READ-ONLY</span></div><div className="bridge-account-actions"><button onClick={loadMailbox} disabled={busy}><RefreshCw size={16}/> Refresh</button><button onClick={disconnect} disabled={busy}>Disconnect</button></div></div>
          <div className="bridge-mail-layout">
            <aside className="bridge-mail-list"><div className="bridge-list-head"><Inbox size={17}/> Recent inbox <small>{messages.length}{reachedLimit?'+' : ''}</small></div>
              {busy&&<div className="bridge-load">Loading messages…</div>}
              {!busy&&messages.length===0&&<div className="bridge-load">No messages loaded from this inbox.</div>}
              {!busy&&messages.map(item=><button key={item.id} className={'bridge-mail-item '+(selected?.id===item.id?'is-active':'')} onClick={()=>openMessage(item)}>
                <div><strong>{item.from}</strong>{item.unread&&<span className="bridge-unread"/>}</div>
                <b>{item.subject}</b><span>{item.preview}</span>
              </button>)}
              {reachedLimit&&<div className="bridge-pagination-note">Showing up to 15 recent messages. Full paging comes next.</div>}
            </aside>
            <article className="bridge-mail-reader">
              {!selected ? <div className="bridge-reader-empty"><Mail size={32}/><h3>Ready to read.</h3><p>Select an email from the Gmail inbox on the left.</p></div>
              : <><div className="bridge-reader-bar"><button className="bridge-icon-button bridge-reader-back" onClick={()=>setSelected(null)} aria-label="Back to Gmail inbox"><ArrowLeft size={18}/></button><span>GMAIL MESSAGE · READ ONLY</span></div>
                <div className="bridge-reader-content"><h3>{selected.subject}</h3><p className="bridge-reader-from">{selected.from}</p><p className="bridge-reader-meta">{new Date(selected.date).toLocaleString()}</p><div className="bridge-message-content">{reading?'Loading full message…':messageBody?.body||'No plain-text message body was found.'}</div>{messageError&&<p className="bridge-error">{messageError}</p>}<div className="bridge-reader-security"><LockKeyhole size={16}/> Remote HTML, images and attachments are not rendered in the pilot.</div></div>
              </>}
            </article>
          </div>
        </div>}
      {error&&<div className="bridge-error"><CircleAlert size={16}/>{error}</div>}
      <footer className="bridge-footer"><span>OAuth state + PKCE · HttpOnly session cookie · plain-text only</span><a href="https://github.com/MichaelWave369/PhiMail/blob/main/docs/BRIDGE.md" target="_blank" rel="noreferrer">Bridge design <ArrowRight size={14}/></a></footer>
    </section>
  </div>;
}
