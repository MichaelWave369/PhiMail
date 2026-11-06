/**
 * Gmail-specific adapter for the shared PhiMail read-only mailbox contract.
 * External requests use fixed Google API URLs through the existing bounded,
 * token-aware server fetch functions. No browser-supplied service URLs.
 */
const GMAIL_ROOT='https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_BODY_BYTES=1024*1024;
const MESSAGE_ID=/^[A-Za-z0-9_-]{1,128}$/;

function headersOf(payload){
  const result=Object.create(null);
  const headers=Array.isArray(payload?.headers)?payload.headers.slice(0,120):[];
  for(const entry of headers){
    if(typeof entry?.name!=='string' || typeof entry.value!=='string')continue;
    const name=entry.name.toLowerCase();
    if(!['from','to','subject'].includes(name))continue;
    if(!Object.hasOwn(result,name))result[name]=entry.value.slice(0,500);
  }
  return result;
}
export function gmailPlainText(payload){
  let visited=0;
  function visit(part,depth){
    if(!part || typeof part!=='object'||depth>12||++visited>150)return '';
    if(part.mimeType==='text/plain' && typeof part.body?.data==='string'){
      const data=part.body.data;
      if(data.length>270_000||!/^[A-Za-z0-9_-]*={0,2}$/.test(data))return '';
      try{return Buffer.from(data,'base64url').toString('utf8').slice(0,100_000);}
      catch{return '';}
    }
    if(!Array.isArray(part.parts))return '';
    for(const child of part.parts.slice(0,30)){
      const found=visit(child,depth+1);
      if(found)return found;
    }
    return '';
  }
  return visit(payload,0);
}
export function gmailEnvelope(record,mailboxEmail){
  if(!record || typeof record!=='object' || !MESSAGE_ID.test(record.id||'')){
    throw Object.assign(new Error('Invalid Gmail record'),{status:502});
  }
  const h=headersOf(record.payload);
  const sender=(h.from||'(Unknown sender)').slice(0,320);
  const ms=Number(record.internalDate);
  const validTime=Number.isFinite(ms)&&ms>0&&ms<=8.64e15;
  const date=validTime?new Date(ms).toISOString():new Date(0).toISOString();
  return {
    id:record.id,
    threadId:typeof record.threadId==='string'?record.threadId.slice(0,128):null,
    from:sender,
    email:sender,
    to:String(h.to||mailboxEmail).slice(0,320),
    subject:String(h.subject||'(No subject)').slice(0,500),
    date,
    preview:typeof record.snippet==='string'?record.snippet.slice(0,1000):'',
    unread:Array.isArray(record.labelIds)&&record.labelIds.includes('UNREAD'),
    starred:Array.isArray(record.labelIds)&&record.labelIds.includes('STARRED'),
    labels:[],
    folder:'inbox',
    provider:'gmail',
  };
}
/**
 * requestProvider(url,options,maxBytes) and accessToken(session) are private
 * bridge-owned functions. No Google credentials enter the shared mail layer.
 */
export function createGmailReadAdapter({requestProvider,accessToken,ready}){
  if(typeof requestProvider!=='function'||typeof accessToken!=='function'){
    throw new TypeError('Gmail adapter requires server-side provider clients');
  }
  async function gmailGet(session,path,maxBytes=256_000){
    const token=await accessToken(session);
    return requestProvider(GMAIL_ROOT+path,{
      headers:{Authorization:'Bearer '+token}
    },maxBytes);
  }
  return Object.freeze({
    id:'gmail',
    ready:Boolean(ready),
    async profile(accessTokenValue){
      return requestProvider(GMAIL_ROOT+'/profile',{
        headers:{Authorization:'Bearer '+accessTokenValue}
      },64_000);
    },
    async listInbox({session,limit}){
      const list=await gmailGet(session,'/messages?labelIds=INBOX&maxResults='+limit);
      const ids=Array.isArray(list?.messages)?
        list.messages.slice(0,limit).filter(item=>
          typeof item?.id==='string'&&MESSAGE_ID.test(item.id)):[];
      const messages=[];
      for(let i=0;i<ids.length;i+=5){
        const batch=await Promise.all(ids.slice(i,i+5).map(item=>
          gmailGet(session,'/messages/'+encodeURIComponent(item.id)+'?format=metadata')));
        messages.push(...batch.map(record=>gmailEnvelope(record,session.email)));
      }
      return {messages,nextPageAvailable:Boolean(list?.nextPageToken)};
    },
    async readMessage({session,id}){
      if(!MESSAGE_ID.test(id||''))throw Object.assign(new Error('Invalid message identifier'),{status:400});
      const record=await gmailGet(session,'/messages/'+encodeURIComponent(id)+'?format=full',MAX_BODY_BYTES);
      return {
        ...gmailEnvelope(record,session.email),
        body:gmailPlainText(record.payload)||
          '[No plain-text body found. HTML is deliberately not rendered in this pilot.]',
      };
    },
  });
}
