import { useEffect, useRef, useState } from 'react';
import {
  Archive, ArrowDownToLine, ArrowLeft, ArrowRight, Check, ChevronDown,
  ExternalLink, FilePenLine, FileUp, Inbox, LayoutGrid, LockKeyhole,
  Mail, MailOpen, Menu, PanelLeftClose, Plus, RotateCcw, Search, Send,
  Settings2, ShieldCheck, Sparkles, Star, Trash2, Network, X
} from 'lucide-react';
import { DEMO_ADDRESS, seedMessages, validateImportedMessages } from './demo.js';
import BridgePanel from './BridgePanel.jsx';
import FieldConnections from './integrations/FieldConnections.jsx';

const KEY = 'phimail-demo-v1';
const BLANK = {to:'', subject:'', body:'', editingId:null};
const NAV = [
  {id:'inbox',title:'Inbox',icon:Inbox},
  {id:'starred',title:'Starred',icon:Star},
  {id:'sent',title:'Sent',icon:Send},
  {id:'drafts',title:'Drafts',icon:FilePenLine},
  {id:'archive',title:'Archive',icon:Archive},
  {id:'trash',title:'Trash',icon:Trash2}
];

function initialMessages(){
  try { const saved=localStorage.getItem(KEY); if(saved) return validateImportedMessages(JSON.parse(saved)); }
  catch { /* ignore blocked/corrupt demo storage */ }
  return seedMessages.map(message=>({...message}));
}
function shortDate(value){
  const date=new Date(value), today=new Date();
  return new Intl.DateTimeFormat(undefined,date.toDateString()===today.toDateString()?{hour:'numeric',minute:'2-digit'}:{month:'short',day:'numeric'}).format(date);
}
function completeDate(value){return new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));}
function initials(value){return (value||'Mail').split(' ').slice(0,2).map(x=>x[0]||'').join('').toUpperCase();}
function tint(value){return 'tone-'+(Array.from(value||'').reduce((n,c)=>n+c.charCodeAt(0),0)%5);}
function preview(value){return (value||'').replace(/\s+/g,' ').slice(0,110);}

export default function App(){
  const [messages,setMessages]=useState(initialMessages);
  const [folder,setFolder]=useState('inbox');
  const [selectedId,setSelectedId]=useState('m1');
  const [query,setQuery]=useState('');
  const [unreadOnly,setUnreadOnly]=useState(false);
  const [compose,setCompose]=useState(false);
  const [draft,setDraft]=useState(BLANK);
  const [dialog,setDialog]=useState('');
  const [bridgeOpen,setBridgeOpen]=useState(()=>import.meta.env.DEV && (new URLSearchParams(window.location.search).has('phimail')||new URLSearchParams(window.location.search).has('outlook')));
  const [bridgeInitialProvider,setBridgeInitialProvider]=useState(()=>new URLSearchParams(window.location.search).has('outlook')?'outlook':'gmail');
  const [fieldConnectionsOpen,setFieldConnectionsOpen]=useState(()=>import.meta.env.DEV && new URLSearchParams(window.location.search).has('phiid'));
  const [toast,setToast]=useState('');
  const [mobileMenu,setMobileMenu]=useState(false);
  const [mobileReader,setMobileReader]=useState(false);
  const [collapsed,setCollapsed]=useState(false);
  const searchRef=useRef(null);
  const importRef=useRef(null);

  useEffect(()=>{try{localStorage.setItem(KEY,JSON.stringify(messages));}catch{/* demo storage may be disabled */}},[messages]);
  useEffect(()=>{if(!toast)return; const id=setTimeout(()=>setToast(''),4500);return()=>clearTimeout(id);},[toast]);
  useEffect(()=>{
    const keydown=event=>{
      if(event.key==='Escape'){setCompose(false);setDialog('');setMobileReader(false);setMobileMenu(false);}
      const tag=document.activeElement?.tagName;
      const typing=['INPUT','TEXTAREA','SELECT'].includes(tag)||document.activeElement?.isContentEditable;
      if(!typing&&!event.altKey&&!event.metaKey&&!event.ctrlKey&&!compose&&!dialog){
        if(event.key==='/'){event.preventDefault();searchRef.current?.focus();}
        if(event.key.toLowerCase()==='c'){event.preventDefault();startCompose();}
      }
    };
    window.addEventListener('keydown',keydown);
    return()=>window.removeEventListener('keydown',keydown);
  },[compose,dialog]);

  const visible=messages.filter(m=>folder==='starred'?m.starred&&m.folder!=='trash':m.folder===folder)
    .filter(m=>!unreadOnly||m.unread)
    .filter(m=>{const q=query.trim().toLowerCase();return !q||[m.from,m.email,m.to,m.subject,m.body].some(x=>String(x||'').toLowerCase().includes(q));})
    .sort((a,b)=>Date.parse(b.date)-Date.parse(a.date));
  const active=visible.find(m=>m.id===selectedId)||visible[0]||null;
  const unreadCount=messages.filter(m=>m.folder==='inbox'&&m.unread).length;
  const draftCount=messages.filter(m=>m.folder==='drafts').length;

  function navigate(next){
    setFolder(next);setSelectedId(null);setUnreadOnly(false);setQuery('');setMobileReader(false);setMobileMenu(false);
  }
  function patch(id,changes){setMessages(old=>old.map(m=>m.id===id?{...m,...changes}:m));}
  function openMessage(message){
    setSelectedId(message.id);setMobileReader(true);if(unreadOnly)setUnreadOnly(false);
    if(message.unread)patch(message.id,{unread:false});
  }
  function startCompose(message=null,mode='new'){
    if(!message)setDraft({...BLANK});
    else if(mode==='edit')setDraft({to:message.to,subject:message.subject,body:message.body,editingId:message.id});
    else if(mode==='reply')setDraft({to:message.email,subject:/^re:/i.test(message.subject)?message.subject:'Re: '+message.subject,body:'\n\n\n--- Original message ---\nFrom: '+message.from+'\n'+message.body,editingId:null});
    else setDraft({to:'',subject:/^fwd:/i.test(message.subject)?message.subject:'Fwd: '+message.subject,body:'\n\n--- Forwarded message ---\nFrom: '+message.from+'\n'+message.body,editingId:null});
    setCompose(true);
  }
  function saveDraft(){
    if(!draft.to.trim()&&!draft.subject.trim()&&!draft.body.trim()){setCompose(false);return;}
    const data={folder:'drafts',from:'You',email:DEMO_ADDRESS,to:draft.to.trim(),subject:draft.subject.trim()||'(No subject)',body:draft.body,date:new Date().toISOString(),unread:false,starred:false,labels:[]};
    if(draft.editingId)patch(draft.editingId,data);
    else setMessages(old=>[{id:crypto.randomUUID(),...data},...old]);
    setCompose(false);navigate('drafts');setToast('Draft saved in this browser only.');
  }
  function sendDemo(){
    const recipients=draft.to.split(',').map(x=>x.trim()).filter(Boolean);
    if(!recipients.length||recipients.some(x=>!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x))){setToast('Please enter a valid recipient address.');return;}
    if(!draft.subject.trim()&&!draft.body.trim()){setToast('Write a subject or body first.');return;}
    const message={id:crypto.randomUUID(),folder:'sent',from:'You',email:DEMO_ADDRESS,to:recipients.join(', '),subject:draft.subject.trim()||'(No subject)',body:draft.body,date:new Date().toISOString(),unread:false,starred:false,labels:[]};
    setMessages(old=>[message,...old.filter(m=>m.id!==draft.editingId)]);setCompose(false);navigate('sent');setSelectedId(message.id);
    setToast('Demo only: saved in local Sent. No email was delivered.');
  }
  function externalMail(){
    window.location.href='mailto:'+draft.to+'?subject='+encodeURIComponent(draft.subject)+'&body='+encodeURIComponent(draft.body);
    setToast('Handoff requested to your default mail app; PhiMail sent nothing.');
  }
  function exportMessages(){
    const blob=new Blob([JSON.stringify(messages,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download='phimail-demo-export.json';document.body.append(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);setToast('Demo mailbox exported as JSON.');
  }
  async function importMessages(event){
    const file=event.target.files?.[0];if(!file)return;
    try{
      if(file.size>35000000)throw new Error('File exceeds 35 MB.');
      const next=validateImportedMessages(JSON.parse(await file.text()));
      setMessages(next);navigate('inbox');setDialog('');setToast('Imported '+next.length+' demo messages locally.');
    }catch(error){setToast('Import failed: '+error.message);}
    event.target.value='';
  }
  function reset(){
    if(!window.confirm('Reset local demo messages? This discards your local changes.'))return;
    setMessages(seedMessages.map(m=>({...m})));navigate('inbox');setSelectedId('m1');setDialog('');setToast('Demo mailbox restored.');
  }
  function moveActive(destination){
    if(!active)return;patch(active.id,{folder:destination});setMobileReader(false);setToast('Message moved locally.');
  }

  return <div className="app-shell">
    <div className="glow glow-left" aria-hidden="true"/><div className="glow glow-right" aria-hidden="true"/>
    <aside className={'sidebar '+(mobileMenu?'mobile-open ':'')+(collapsed?'sidebar-compact':'')}>
      <div className="brand-row">
        <div className="brand-mark"><Mail size={23}/><span>Φ</span></div>
        {!collapsed&&<div className="brand-name"><strong>PhiMail</strong><small>THE FIELD IS OPEN</small></div>}
        <button className="icon-button desktop-collapse" aria-label="Toggle sidebar" onClick={()=>setCollapsed(x=>!x)}><PanelLeftClose size={19}/></button>
        <button className="icon-button mobile-close" aria-label="Close menu" onClick={()=>setMobileMenu(false)}><X size={20}/></button>
      </div>
      <button className="compose-primary" onClick={()=>startCompose()}><Plus size={19}/>{!collapsed&&'New message'}</button>
      <div className="nav-caption">{collapsed?'•':'WORKSPACE'}</div>
      <nav aria-label="Mail folders" className="folder-nav">{NAV.map(item=>{
        const Icon=item.icon,count=item.id==='inbox'?unreadCount:item.id==='drafts'?draftCount:0;
        return <button key={item.id} title={item.title} className={'folder-link '+(folder===item.id?'is-selected':'')} onClick={()=>navigate(item.id)}><Icon size={19}/>{!collapsed&&<><span>{item.title}</span>{count>0&&<b className="folder-count">{count}</b>}</>}</button>;
      })}</nav>
      <div className="sidebar-rule"/>
      {!collapsed&&<div className="nav-caption">YOUR FIELD</div>}
      <button className="folder-link" onClick={()=>setDialog('accounts')}><LayoutGrid size={19}/>{!collapsed&&<><span>Accounts</span><small className="soon-label">SOON</small></>}</button>
      <button className="folder-link" onClick={()=>setDialog('settings')}><Settings2 size={19}/>{!collapsed&&<span>Local settings</span>}</button>
      <button className="folder-link" onClick={()=>setFieldConnectionsOpen(true)}><Network size={19}/>{!collapsed&&<span>Field Connections</span>}</button>
      <div className="sidebar-bottom">
        {!collapsed&&<div className="sidebar-promo"><span className="promo-icon"><Sparkles size={20}/></span><strong>Communication, recentered.</strong><p>Open standards. Private by design. Always your choice.</p><small>Φ A PHIOS EXPERIMENT</small></div>}
        <a href="https://github.com/MichaelWave369/PhiMail" target="_blank" rel="noreferrer" className="open-repo"><ExternalLink size={16}/>{!collapsed&&'Open-source project'}</a>
      </div>
    </aside>
    {mobileMenu&&<button className="mobile-scrim" onClick={()=>setMobileMenu(false)} aria-label="Dismiss menu"/>}

    <main className="main">
      <header className="topbar"><div className="topbar-location"><button className="icon-button mobile-menu" onClick={()=>setMobileMenu(true)} aria-label="Open menu"><Menu size={20}/></button><span>PHIOS / COMMUNICATIONS</span><span className="crumb">/</span><b>PhiMail</b></div><div className="topbar-side"><span className="demo-status"><i/>LOCAL DEMO</span>{import.meta.env.DEV&&<button className="pilot-open-button" onClick={()=>setBridgeOpen(true)}><Mail size={15}/> Mail providers</button>}<button className="profile-icon" onClick={()=>setDialog('accounts')} aria-label="Account details">Φ</button></div></header>
      <div className="page-heading"><div><div className="overline"><i/>YOUR MESSAGE SPACE</div><h1>{NAV.find(x=>x.id===folder)?.title}<span className="accent-period">.</span></h1><p>Less noise. More meaning. Your space to connect.</p></div><div className="heading-right"><span><strong>{visible.length}</strong> messages</span><button className="outline-button" onClick={()=>setDialog('accounts')}><Plus size={17}/> Add account</button></div></div>

      <div className="mail-grid">
        <section className={'list-panel '+(mobileReader?'reader-open':'')} aria-label="Message list">
          <div className="list-controls"><label className="search"><Search size={19}/><input ref={searchRef} value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search your messages..." aria-label="Search messages"/>{query&&<button type="button" aria-label="Clear search" onClick={()=>setQuery('')}><X size={16}/></button>}<kbd>/</kbd></label><button className={'unread-filter '+(unreadOnly?'on':'')} onClick={()=>setUnreadOnly(x=>!x)} aria-pressed={unreadOnly}><i/>Unread</button></div>
          <div className="list-caption"><span>MESSAGES <b>{visible.length}</b></span><span>NEWEST FIRST <ChevronDown size={14}/></span></div>
          <div className="message-list">
            {visible.length===0&&<div className="empty-list"><MailOpen size={32}/><h3>Nothing here</h3><p>{query?'No messages matched your search.':'This folder is enjoying some peace and quiet.'}</p></div>}
            {visible.map(message=><div key={message.id} className={'message-item '+(active?.id===message.id?'active ':'')+(message.unread?'unread':'')}>
              <button className="message-select" onClick={()=>message.folder==='drafts'?startCompose(message,'edit'):openMessage(message)}>
                <span className={'avatar '+tint(message.from)}>{initials(message.from)}</span>
                <span className="message-details"><span className="message-first"><strong>{message.from}</strong><time>{shortDate(message.date)}</time></span><strong className="subject">{message.subject}</strong><span className="preview">{preview(message.body)}</span><span className="message-labels">{(message.labels||[]).map(label=><small key={label}>{label}</small>)}{message.unread&&<i title="Unread message"/>}</span></span>
              </button>
              <button className={'message-star '+(message.starred?'starred':'')} aria-label={message.starred?'Remove star':'Star message'} onClick={()=>patch(message.id,{starred:!message.starred})}><Star size={16} fill={message.starred?'currentColor':'none'}/></button>
            </div>)}
          </div>
          <div className="list-foot"><LockKeyhole size={14}/> Fictional messages, stored only in your browser</div>
        </section>

        <section className={'reading-panel '+(mobileReader?'mobile-active':'')} aria-label="Message details">
          {active?<><div className="reader-tools"><button className="icon-button mobile-back" onClick={()=>setMobileReader(false)} aria-label="Back to message list"><ArrowLeft size={20}/></button><span>MESSAGE VIEW</span><div className="reader-actions">
            <button className="icon-button" title="Toggle read state" aria-label={active.unread?'Mark read':'Mark unread'} onClick={()=>patch(active.id,{unread:!active.unread})}>{active.unread?<MailOpen size={19}/>:<Mail size={19}/>}</button>
            <button className="icon-button" title="Archive" aria-label="Archive" onClick={()=>moveActive('archive')}><Archive size={19}/></button>
            <button className="icon-button" title={active.folder==='trash'?'Restore':'Move to trash'} aria-label={active.folder==='trash'?'Restore':'Move to trash'} onClick={()=>moveActive(active.folder==='trash'?'inbox':'trash')}>{active.folder==='trash'?<RotateCcw size={19}/>:<Trash2 size={19}/>}</button>
            <button className={'icon-button '+(active.starred?'starred':'')} title="Toggle star" aria-label={active.starred?'Unstar':'Star'} onClick={()=>patch(active.id,{starred:!active.starred})}><Star size={19} fill={active.starred?'currentColor':'none'}/></button>
          </div></div>
          <div className="reader-body"><div className="reader-eyebrow"><i/> IN YOUR FIELD {active.labels?.length>0&&<span>· {active.labels.join(', ')}</span>}</div><h2>{active.subject}</h2><div className="from-row"><span className={'sender-avatar '+tint(active.from)}>{initials(active.from)}</span><div className="sender-info"><strong>{active.from}</strong><span>{active.email} <em>to {active.to||DEMO_ADDRESS}</em></span></div><time>{completeDate(active.date)}</time></div>
            <article className="body-text">{active.body}</article>
            {active.folder!=='drafts'&&<div className="reply-row"><button className="soft-button" onClick={()=>startCompose(active,'reply')}><ArrowLeft size={16}/> Reply</button><button className="outline-button" onClick={()=>startCompose(active,'forward')}><ArrowRight size={16}/> Forward</button></div>}
            <div className="reader-note"><ShieldCheck size={17}/> Sample content only. No real mail server is connected.</div>
          </div></>:<div className="empty-reader"><Mail size={35}/><h2>Make space for what matters.</h2><p>Select a message to read it, or begin a conversation.</p><button className="soft-button" onClick={()=>startCompose()}><Plus size={18}/> Compose</button></div>}
        </section>
      </div>
      <footer className="footer"><span><b>Φ</b> PhiMail v0.1 · local-first prototype</span><span>Built for the open field · <a href="https://phi-field.com" target="_blank" rel="noreferrer">phi-field.com</a></span></footer>
    </main>

    {compose&&<div className="modal-screen" onMouseDown={e=>{if(e.target===e.currentTarget)setCompose(false);}}><section className="modal compose-modal" role="dialog" aria-modal="true" aria-labelledby="compose-heading">
      <header className="modal-heading"><div><small>Φ COMMUNICATIONS</small><h2 id="compose-heading">{draft.editingId?'Edit draft':'New message'}</h2></div><button className="icon-button" onClick={()=>setCompose(false)} aria-label="Close composer"><X size={20}/></button></header>
      <div className="compose-fields"><label>FROM <span>{DEMO_ADDRESS}</span></label><label>TO <input aria-label="Recipients" type="text" placeholder="recipient@example.com" value={draft.to} onChange={e=>setDraft(x=>({...x,to:e.target.value}))}/></label><label>SUBJECT <input aria-label="Subject" placeholder="Something worth sharing..." value={draft.subject} onChange={e=>setDraft(x=>({...x,subject:e.target.value}))}/></label><textarea aria-label="Message body" placeholder="Write something meaningful..." value={draft.body} onChange={e=>setDraft(x=>({...x,body:e.target.value}))}/></div>
      <div className="compose-notice"><LockKeyhole size={16}/> This is a demo. Save as sent does not deliver any mail.</div>
      <div className="compose-bottom"><button className="outline-button" onClick={saveDraft}><FilePenLine size={17}/> Save draft</button><div><button className="outline-button" onClick={externalMail}><ExternalLink size={16}/> Open in mail app</button><button className="send-button" onClick={sendDemo}>Save as sent demo <ArrowRight size={17}/></button></div></div>
    </section></div>}

    {dialog&&<div className="modal-screen" onMouseDown={e=>{if(e.target===e.currentTarget)setDialog('');}}><section className="modal info-modal" role="dialog" aria-modal="true" aria-labelledby="dialog-heading">
      <header className="modal-heading"><div><small>{dialog==='accounts'?'FUTURE CONNECTIONS':'LOCAL DEMO SETTINGS'}</small><h2 id="dialog-heading">{dialog==='accounts'?'Bring your own mailbox.':'Your demo, your rules.'}</h2></div><button className="icon-button" aria-label="Close" onClick={()=>setDialog('')}><X size={20}/></button></header>
      {dialog==='accounts'?<><p>PhiMail is a local demo today. Real sign-in requires a secure account bridge and provider configuration, so these are not connected yet.</p>
        <div className="provider"><span>G</span><div><strong>Gmail</strong><small>OAuth authorization</small></div><b>PLANNED</b></div>
        <div className="provider"><span>M</span><div><strong>Microsoft Outlook</strong><small>Microsoft Graph mail access</small></div><b>PLANNED</b></div>
        <div className="provider"><span>Φ</span><div><strong>Independent mail providers</strong><small>IMAP / SMTP through a secure bridge</small></div><b>PLANNED</b></div>
        <div className="dialog-note"><ShieldCheck size={17}/> Never paste mailbox passwords into a public demo.</div>{import.meta.env.DEV&&<button className="pilot-dialog-button" onClick={()=>{setDialog('');setBridgeOpen(true);}}><Mail size={17}/> Open the experimental read-only mail providers</button>}
      </>:<><p>Demo messages use <strong>unencrypted localStorage</strong> in this browser. Do not import sensitive real emails or store credentials here.</p>
        <div className="settings-list"><button onClick={exportMessages}><ArrowDownToLine size={19}/><span><strong>Export demo mailbox</strong><small>Download your sample messages as JSON</small></span></button><button onClick={()=>importRef.current?.click()}><FileUp size={19}/><span><strong>Import demo JSON</strong><small>Replace messages from a previous demo export</small></span></button><input ref={importRef} hidden type="file" accept=".json,application/json" onChange={importMessages}/><button onClick={reset}><RotateCcw size={19}/><span><strong>Reset sample mailbox</strong><small>Discard local changes</small></span></button></div>
        <div className="dialog-note"><LockKeyhole size={17}/> Encrypted, authenticated storage will come with real accounts.</div>
      </>}
      <button className="outline-button dialog-close" onClick={()=>setDialog('')}>Back to inbox</button>
    </section></div>}

    {import.meta.env.DEV&&bridgeOpen&&<BridgePanel initialProvider={bridgeInitialProvider} onClose={()=>setBridgeOpen(false)}/>}
    {fieldConnectionsOpen&&<FieldConnections onClose={()=>setFieldConnectionsOpen(false)}
      onOpenGmail={()=>{setBridgeInitialProvider('gmail');setFieldConnectionsOpen(false);setBridgeOpen(true);}}
      onOpenOutlook={()=>{setBridgeInitialProvider('outlook');setFieldConnectionsOpen(false);setBridgeOpen(true);}}/>}
    {toast&&<div className="toast" role="status"><Check size={17}/><span>{toast}</span><button onClick={()=>setToast('')} aria-label="Dismiss notice"><X size={15}/></button></div>}
  </div>;
}
