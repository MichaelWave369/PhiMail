/**
 * R7 optional IMAP reader.
 *
 * A single server-configured account only. The browser NEVER chooses the host
 * or sends its IMAP password. Every operation opens a fresh authenticated,
 * TLS-verified, READ-ONLY INBOX connection and closes it afterwards.
 */
import { randomBytes } from 'node:crypto';
import { ImapFlow } from 'imapflow';

const MAX_BODY = 100_000;
const MAX_MESSAGE = 512_000;
const HANDLE = /^[A-Za-z0-9_-]{20,60}$/;
const UID = /^[1-9]\d{0,9}$/;

function fail(message,status=502){
  return Object.assign(new Error(message),{status});
}
export function imapReady(env){
  if(env.NODE_ENV==='production'||env.BRIDGE_PUBLIC_ORIGIN!=='http://127.0.0.1:5173')return false;
  const host=env.IMAP_HOST||'';
  const port=Number(env.IMAP_PORT||993);
  const user=env.IMAP_USERNAME||'';
  const password=env.IMAP_APP_PASSWORD||'';
  const unlock=env.IMAP_UNLOCK_KEY||'';
  return host.length>3&&host.length<=253&&host.includes('.')&&
    /^[a-zA-Z0-9.-]+$/.test(host)&&!host.startsWith('.')&&!host.endsWith('.')&&
    !host.includes('..')&&!/^\d+(?:\.\d+){3}$/.test(host)&&
    Number.isInteger(port)&&port>=1&&port<=65535&&
    user.length>0&&user.length<=320&&password.length>=1&&password.length<=4096&&
    unlock.length>=32&&unlock.length<=256;
}
function options(env){
  return {
    host:env.IMAP_HOST,
    port:Number(env.IMAP_PORT||993),
    secure:true,
    tls:{rejectUnauthorized:true},
    auth:{user:env.IMAP_USERNAME,pass:env.IMAP_APP_PASSWORD},
    logger:false,disableAutoIdle:true,disableCompression:true,
    connectionTimeout:8000,greetingTimeout:6000,socketTimeout:12000,
    maxLiteralSize:MAX_MESSAGE,
    maxLineLength:16_384,
    maxResponseSize:1024*1024,
  };
}
function text(value,max){
  return typeof value==='string'?value.slice(0,max):'';
}
function address(list){
  const first=Array.isArray(list)?list[0]:null;
  if(!first || typeof first!=='object')return '(Unknown sender)';
  const email=text(first.address,240);
  const name=text(first.name,100);
  return name?(name+' <'+email+'>').slice(0,320):email||'(Unknown sender)';
}
function dateString(value){
  const d=value instanceof Date?value:new Date(value||0);
  return Number.isFinite(d.getTime())?d.toISOString():new Date(0).toISOString();
}
export function imapEnvelope(msg,handle,mailboxEmail){
  if(!msg||!HANDLE.test(handle)||!UID.test(String(msg.uid))||!msg.envelope){
    throw fail('Invalid IMAP message envelope');
  }
  const size=Number(msg.size||0);
  if(!Number.isFinite(size)||size<0)throw fail('Invalid IMAP message size');
  const env=msg.envelope;
  return {
    id:handle,threadId:null,
    from:address(env.from),email:address(env.from),
    to:Array.isArray(env.to)&&env.to.length?
      env.to.slice(0,8).map(one=>address([one])).join(', ').slice(0,320):text(mailboxEmail,320),
    subject:text(env.subject,500)||'(No subject)',
    date:dateString(msg.internalDate||env.date),
    preview:'',unread:!(msg.flags instanceof Set&&msg.flags.has('\\Seen')),
    starred:msg.flags instanceof Set&&msg.flags.has('\\Flagged'),
    labels:[],folder:'inbox',provider:'imap',
  };
}
export function firstPlainPart(structure){
  let visited=0;
  function walk(node,depth){
    if(!node||typeof node!=='object'||depth>10||++visited>100)return null;
    const type=String(node.type||'').toLowerCase();
    const disposition=String(node.disposition||'').toLowerCase();
    if(type==='text/plain'&&disposition!=='attachment'&&
       !node.dispositionParameters?.filename && !node.parameters?.name){
      const part=typeof node.part==='string'?node.part:'1';
      if(/^\d+(?:\.\d+){0,10}$/.test(part))return part;
    }
    if(Array.isArray(node.childNodes)){
      for(const child of node.childNodes.slice(0,25)){
        const found=walk(child,depth+1);
        if(found)return found;
      }
    }
    return null;
  }
  return walk(structure,0);
}
async function readStream(stream){
  if(!stream)return '';
  const parts=[];let size=0;
  for await (const item of stream){
    const chunk=Buffer.from(item);
    size+=chunk.length;
    if(size>MAX_BODY)throw fail('IMAP text body exceeded limit');
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString('utf8').slice(0,MAX_BODY);
}
export function createImapReadAdapter({env=process.env,clientFactory=opts=>new ImapFlow(opts)}={}){
  const ready=imapReady(env);
  async function withInbox(work){
    if(!ready)throw fail('Local IMAP provider not configured',503);
    const client=clientFactory(options(env));
    let lock;
    try{
      await client.connect();
      lock=await client.getMailboxLock('INBOX',{readOnly:true,acquireTimeout:8000});
      if(client.mailbox?.readOnly!==true)throw fail('IMAP server did not confirm read-only mode');
      return await work(client);
    }finally{
      if(lock)lock.release();
      try{await client.logout();}catch{try{client.close();}catch{}}
    }
  }
  return Object.freeze({
    id:'imap',ready,
    async probe(){
      await withInbox(async()=>true);
      return true;
    },
    async listInbox({session,limit}){
      return withInbox(async client=>{
        const count=Number(client.mailbox.exists||0);
        if(!Number.isSafeInteger(count)||count<0)throw fail('Invalid mailbox size');
        const validity=String(client.mailbox.uidValidity||'');
        const refs=new Map(),messages=[];
        if(count===0){session.messageRefs=refs;session.uidValidity=validity;return {messages,nextPageAvailable:false};}
        const start=Math.max(1,count-limit+1);
        const items=await client.fetchAll(start+':'+count,{
          envelope:true,flags:true,internalDate:true,size:true,uid:true
        });
        if(!Array.isArray(items)||items.length>limit)throw fail('Invalid IMAP inbox response');
        for(const item of items.reverse()){
          if(!UID.test(String(item?.uid)))continue;
          const handle=randomBytes(18).toString('base64url');
          messages.push(imapEnvelope(item,handle,session.email));
          refs.set(handle,Number(item.uid));
        }
        session.messageRefs=refs;
        session.uidValidity=validity;
        return {messages,nextPageAvailable:count>limit};
      });
    },
    async readMessage({session,id}){
      if(!HANDLE.test(id))throw fail('Invalid IMAP message handle',400);
      const uid=session.messageRefs instanceof Map?session.messageRefs.get(id):null;
      if(!uid||!UID.test(String(uid)))throw fail('IMAP message is not in current session list',404);
      return withInbox(async client=>{
        if(String(client.mailbox.uidValidity||'')!==session.uidValidity){
          session.messageRefs=new Map();
          throw fail('IMAP mailbox identity changed. Refresh inbox.',409);
        }
        const message=await client.fetchOne(uid,{
          envelope:true,flags:true,internalDate:true,size:true,bodyStructure:true
        },{uid:true});
        if(!message||Number(message.uid)!==uid)throw fail('IMAP message not found',404);
        const envelope=imapEnvelope(message,id,session.email);
        if(Number(message.size)>MAX_MESSAGE){
          return {...envelope,body:'[Message exceeds local preview limit.]'};
        }
        const part=firstPlainPart(message.bodyStructure);
        if(!part)return {...envelope,body:'[No plain-text part found. HTML and attachments are not rendered.]'};
        const downloaded=await client.download(uid,part,{uid:true,maxBytes:MAX_BODY});
        const body=await readStream(downloaded?.content);
        return {...envelope,body:body||'[No plain-text body found.]'};
      });
    },
  });
}
