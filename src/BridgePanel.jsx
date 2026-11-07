import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CircleAlert, ExternalLink, Inbox, LockKeyhole, Mail, RefreshCw, ShieldCheck, X } from 'lucide-react';
import './bridge.css';

async function getJSON(path, options) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || 'Bridge request failed (' + response.status + ')');
  return json;
}

export default function BridgePanel({ onClose,initialProvider }) {
  const [provider,setProvider]=useState(()=>initialProvider==='outlook'?'outlook':new URLSearchParams(window.location.search).has('outlook')?'outlook':'gmail');
  const [session, setSession] = useState(null);
  const [imapUnlock,setImapUnlock]=useState('');
  const [providers, setProviders] = useState(null);
  const [messages, setMessages] = useState([]);
  const [selected, setSelected] = useState(null);
  const [messageBody, setMessageBody] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [messageError, setMessageError] = useState('');
  const [reachedLimit, setReachedLimit] = useState(false);
  const [accounts,setAccounts]=useState(null);
  const [allBusy,setAllBusy]=useState(false);
  const mailboxEpoch=useRef(0);
  const messageEpoch=useRef(0);
  const refreshAccounts=useCallback(async()=>{
    const result=await getJSON('/api/accounts').catch(()=>null);
    setAccounts(result);
    return result;
  },[]);

  const loadMailbox = useCallback(async () => {
    const epoch=++mailboxEpoch.current;
    ++messageEpoch.current;
    setBusy(true); setError(''); setSelected(null); setMessageBody(null);
    try {
      const data = await getJSON('/api/mail/messages?limit=15&provider='+provider);
      if(epoch!==mailboxEpoch.current)return;
      setMessages(Array.isArray(data.messages) ? data.messages : []);
      setReachedLimit(Boolean(data.nextPageAvailable));
    } catch (cause) {
      if(epoch===mailboxEpoch.current){setError(cause.message);setMessages([]);}
    }finally{if(epoch===mailboxEpoch.current)setBusy(false);}

  }, [provider]);

  useEffect(() => {
    let cancelled = false;
    setSession(null);setMessages([]);setSelected(null);setMessageBody(null);setReachedLimit(false);
    setBusy(false);setError('');
    (async () => {
      try {
        const [status, available, inventory] = await Promise.all([
          getJSON('/api/session?provider='+provider),
          getJSON('/api/providers'),
          getJSON('/api/accounts').catch(()=>null)
        ]);
        if (cancelled) return;
        setSession(status); setProviders(available); setAccounts(inventory);
        if (status.connected) await loadMailbox();
      } catch {
        if (!cancelled) {
          setSession({connected:false});
          setError('The PhiMail bridge is not running. Start npm run bridge:dev on localhost, then reopen this panel.');
        }
      }
    })();
    return () => { cancelled = true; ++mailboxEpoch.current; ++messageEpoch.current; };
  }, [loadMailbox,provider]);

  async function openMessage(item) {
    const epoch=++messageEpoch.current;
    setSelected(item); setMessageBody(null); setReading(true); setMessageError('');
    try {
      const details=await getJSON('/api/mail/messages/'+encodeURIComponent(item.id)+'?provider='+provider);
      if(epoch===messageEpoch.current)setMessageBody(details);
    } catch(cause) {
      if(epoch===messageEpoch.current)setMessageError(cause.message);
    } finally {
      if(epoch===messageEpoch.current)setReading(false);
    }
  }
  async function connectImap(e){
    e.preventDefault();setBusy(true);setError('');
    const unlock=imapUnlock;setImapUnlock('');
    try{
      await getJSON('/api/imap/connect',{
        method:'POST',headers:{
          'Content-Type':'application/json',
          'X-PhiMail-Action':'connect-imap'
        },
        body:JSON.stringify({unlock})
      });
      const status=await getJSON('/api/session?provider=imap');
      setSession(status);
      await loadMailbox();
      await refreshAccounts();
    }catch(cause){setError(cause.message);}
    finally{setBusy(false);}
  }
  async function disconnect() {
    setBusy(true); setError('');
    try {
      await getJSON('/api/session/disconnect?provider='+provider, { method:'POST',headers:{'Content-Type':'application/json',...(provider==='outlook'?{'X-PhiMail-Action':'disconnect-outlook'}:provider==='imap'?{'X-PhiMail-Action':'disconnect-imap'}:{})} });
      ++mailboxEpoch.current;++messageEpoch.current;
      setSession({ connected: false }); setMessages([]); setSelected(null); setMessageBody(null);
      await refreshAccounts();
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }
  async function disconnectAll(){
    setAllBusy(true);setError('');
    try{
      const result=await getJSON('/api/accounts/disconnect-all',{
        method:'POST',
        headers:{'X-PhiMail-Action':'disconnect-all'}
      });
      ++mailboxEpoch.current;++messageEpoch.current;
      setAccounts(result);
      setSession({connected:false});setMessages([]);setSelected(null);setMessageBody(null);
      setReachedLimit(false);setReading(false);setBusy(false);
    }catch(cause){setError(cause.message);}
    finally{setAllBusy(false);}
  }

  const providerReady = providers?.providers?.find(item=>item.id===provider)?.ready===true;
  const isOutlook=provider==='outlook';
  const isImap=provider==='imap';
  const providerLabel=isImap?'IMAP':isOutlook?'Outlook':'Gmail';
  return <div className="bridge-backdrop" role="presentation">
    <section className="bridge-window" role="dialog" aria-modal="true" aria-labelledby="bridge-title">
      <header className="bridge-head">
        <span className="bridge-title-mark">Φ</span>
        <div><div className="bridge-overline">PHIMAIL · READ-ONLY PROVIDER LAB</div><h2 id="bridge-title">{providerLabel} bridge pilot</h2></div>
        <span className="bridge-local-badge"><LockKeyhole size={13}/> LOCAL ONLY</span>
        <button className="bridge-icon-button bridge-close" aria-label="Close mailbox pilot" onClick={onClose}><X size={20}/></button>
      </header>
      <div className="bridge-notice"><ShieldCheck size={19}/><p><b>Experimental read-only connector.</b> Provider tokens remain in the bridge's server memory. No live messages are saved in PhiMail browser storage, and sending, deleting or modifying real messages is not supported.</p></div>
      {providers?.providers&&<div className="bridge-provider-catalog" aria-label="Mail provider adapter availability">
        {providers.providers.map(item=>{
          const state=accounts?.accounts?.find(entry=>entry.provider===item.id);
          return <button key={item.id} type="button" disabled={busy||allBusy}
            aria-pressed={provider===item.id} onClick={()=>setProvider(item.id)}
            className={'bridge-provider-item '+(item.ready?'is-ready ':'')+(provider===item.id?'is-selected':'')}>
            <span>{item.name||item.id}</span>
            <small>{state?.connected?'Connected · read-only':item.ready?'Configured · not connected':item.id==='imap'?'Local setup needed':'Setup required'}</small>
            {state?.connected&&<span className="bridge-provider-email" title={state.email}>{state.email}</span>}
          </button>;
        })}
      </div>}
      {accounts?.accounts&&<div className="bridge-account-center" aria-label="Local mailbox session control">
        <div>
          <strong>{accounts.connected_count} of 3 local mailbox sessions active</strong>
          <small>Independent providers. No PhiID link or cloud grant. Remote tokens and server credentials are not revoked here.</small>
        </div>
        <button type="button" onClick={disconnectAll} disabled={!accounts.connected_count||allBusy||busy}>
          <LockKeyhole size={14}/> {allBusy?'Disconnecting…':'Disconnect all local sessions'}
        </button>
      </div>}

      {session===null ? <div className="bridge-center"><RefreshCw className="bridge-spin" size={30}/><p>Checking bridge connection…</p></div>
      : !session.connected ? <div className="bridge-center">
          <div className="bridge-hero-icon"><Mail size={34}/></div>
          <h3>Connect your {providerLabel} inbox.</h3>
          <p>{isImap?'Read the single IMAP inbox configured on this local server, with a separate local unlock. Your IMAP password never enters React.':'Read your own '+providerLabel+' inbox using a separate server-held OAuth session.'} This does not link your PhiID identity or other mailboxes.</p>
          <div className="bridge-steps">
            <span>1 · Start the loopback-only Node bridge</span>
            <span>2 · {isImap?'Configure TLS IMAP host, credentials and a local unlock in private .env.local':isOutlook?'Configure a Microsoft personal-account app registration':'Configure Google OAuth test credentials'}</span>
            <span>3 · {isImap?'Enter the separate local unlock to authorize this one configured mailbox':isOutlook?"Review Microsoft's Mail.Read + User.Read consent":"Review Google's Gmail read-only consent"}</span>
          </div>
          {providerReady&&(isImap?
            <form className="bridge-imap-form" onSubmit={connectImap}>
              <label htmlFor="bridge-imap-unlock">Local IMAP unlock phrase</label>
              <input id="bridge-imap-unlock" type="password" autoComplete="off"
                spellCheck={false} value={imapUnlock} onChange={e=>setImapUnlock(e.target.value)}
                minLength={1} maxLength={256} required
                placeholder="Private local unlock phrase"/>
              <button className="bridge-primary-link" type="submit" disabled={busy}>
                <LockKeyhole size={17}/> Unlock configured IMAP (read-only)
              </button>
              <small>Not your mailbox password. This phrase is used only to start a temporary local session.</small>
            </form>
            :<a className="bridge-primary-link" href={isOutlook?'/auth/microsoft/start':'/auth/google/start'}>
              Connect {providerLabel} (read-only) <ExternalLink size={17}/>
            </a>)}
          {providers&&!providerReady&&<span className="bridge-config-warn"><CircleAlert size={17}/> {providerLabel} {isImap?'server credentials and unlock':'OAuth credentials'} are not configured on your bridge.</span>}
        </div>
      : <div className="bridge-connected">
          <div className="bridge-account"><div><span className="bridge-connected-dot"/> Connected as <strong>{session.email}</strong><span className="bridge-scope">{providerLabel.toUpperCase()} · READ-ONLY</span></div><div className="bridge-account-actions"><button onClick={loadMailbox} disabled={busy}><RefreshCw size={16}/> Refresh</button><button onClick={disconnect} disabled={busy}>Disconnect</button></div></div>
          <div className="bridge-mail-layout">
            <aside className="bridge-mail-list"><div className="bridge-list-head"><Inbox size={17}/> {providerLabel} inbox <small>{messages.length}{reachedLimit?'+' : ''}</small></div>
              {busy&&<div className="bridge-load">Loading messages…</div>}
              {!busy&&messages.length===0&&<div className="bridge-load">No messages loaded from this inbox.</div>}
              {!busy&&messages.map(item=><button key={item.id} className={'bridge-mail-item '+(selected?.id===item.id?'is-active':'')} onClick={()=>openMessage(item)}>
                <div><strong>{item.from}</strong>{item.unread&&<span className="bridge-unread"/>}</div>
                <b>{item.subject}</b><span>{item.preview}</span>
              </button>)}
              {reachedLimit&&<div className="bridge-pagination-note">Showing up to 15 recent messages. Full paging comes next.</div>}
            </aside>
            <article className="bridge-mail-reader">
              {!selected ? <div className="bridge-reader-empty"><Mail size={32}/><h3>Ready to read.</h3><p>Select an email from the {providerLabel} inbox on the left.</p></div>
              : <><div className="bridge-reader-bar"><button className="bridge-icon-button bridge-reader-back" onClick={()=>setSelected(null)} aria-label="Back to mailbox inbox"><ArrowLeft size={18}/></button><span>{providerLabel.toUpperCase()} MESSAGE · READ ONLY</span></div>
                <div className="bridge-reader-content"><h3>{selected.subject}</h3><p className="bridge-reader-from">{selected.from}</p><p className="bridge-reader-meta">{new Date(selected.date).toLocaleString()}</p><div className="bridge-message-content">{reading?'Loading full message…':messageBody?.body||'No plain-text message body was found.'}</div>{messageError&&<p className="bridge-error">{messageError}</p>}<div className="bridge-reader-security"><LockKeyhole size={16}/> Remote HTML, images and attachments are not rendered in the pilot.</div></div>
              </>}
            </article>
          </div>
        </div>}
      {error&&<div className="bridge-error"><CircleAlert size={16}/>{error}</div>}
      <footer className="bridge-footer"><span>Provider-scoped local sessions · TLS IMAP or OAuth · plain-text only</span><a href="https://github.com/MichaelWave369/PhiMail/blob/main/docs/BRIDGE.md" target="_blank" rel="noreferrer">Bridge design <ArrowRight size={14}/></a></footer>
    </section>
  </div>;
}
