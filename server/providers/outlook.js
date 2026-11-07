/**
 * PhiMail R6: Microsoft Graph v1.0 read-only adapter (personal MSA pilot).
 *
 * Server-authorized Microsoft Graph tokens never enter the browser. Graph IDs
 * are replaced with random per-session opaque handles before returning to UI.
 * Only fixed /me reads are supported: no arbitrary URLs, paging URLs, write
 * endpoints, HTML rendering, or PhiID account linking.
 */
import { randomBytes } from 'node:crypto';

export const GRAPH_ROOT='https://graph.microsoft.com/v1.0';
const RAW_ID=/^[A-Za-z0-9+/_=-]{1,2048}$/;
const HANDLE=/^[A-Za-z0-9_-]{20,60}$/;
const INBOX_SELECT='id,conversationId,from,toRecipients,subject,receivedDateTime,bodyPreview,isRead,flag';
const DETAIL_SELECT=INBOX_SELECT+',body';

function graphError(message,status=502){
  return Object.assign(new Error(message),{status});
}
function emailAddress(entity){
  const addr=entity?.emailAddress;
  if (!addr || typeof addr!=='object') return '(Unknown sender)';
  const email=typeof addr.address==='string'?addr.address.slice(0,320):'';
  const name=typeof addr.name==='string'?addr.name.slice(0,180):'';
  return name ? (name+' <'+email+'>').slice(0,320) : email || '(Unknown sender)';
}
export function graphEnvelope(record,mailboxEmail,handle){
  if(!record || typeof record!=='object' || !HANDLE.test(handle) || !RAW_ID.test(record.id||'')){
    throw graphError('Invalid Microsoft Graph message');
  }
  const dt=typeof record.receivedDateTime==='string'?Date.parse(record.receivedDateTime):NaN;
  const date=Number.isFinite(dt) && dt>=0 && dt<=8.64e15 ? new Date(dt).toISOString() :
    new Date(0).toISOString();
  const from=emailAddress(record.from);
  const recipients=Array.isArray(record.toRecipients)?record.toRecipients.slice(0,10):[];
  const to=recipients.length ? recipients.map(emailAddress).join(', ').slice(0,320) : mailboxEmail;
  return {
    id:handle,
    threadId:typeof record.conversationId==='string'?record.conversationId.slice(0,128):null,
    from,email:from,to,
    subject:typeof record.subject==='string'?record.subject.slice(0,500):'(No subject)',
    date,
    preview:typeof record.bodyPreview==='string'?record.bodyPreview.slice(0,1000):'',
    unread:record.isRead===false,
    starred:record.flag?.flagStatus==='flagged',
    labels:[],
    folder:'inbox',
    provider:'outlook',
  };
}
export function graphPlainBody(record){
  const body=record?.body;
  // Never treat HTML as text or render HTML, even if Microsoft ignores Prefer.
  if(!body || typeof body.content!=='string' || String(body.contentType).toLowerCase()!=='text'){
    return '[No plain-text body returned. HTML is deliberately not rendered.]';
  }
  return body.content.slice(0,100_000);
}
export function createOutlookReadAdapter({requestProvider,accessToken,ready}){
  if(typeof requestProvider!=='function'||typeof accessToken!=='function'){
    throw new TypeError('Outlook adapter requires private server functions');
  }
  async function graphGet(session,path,bytes=256_000){
    const token=await accessToken(session);
    return requestProvider(GRAPH_ROOT+path,{
      headers:{
        Authorization:'Bearer '+token,
        Prefer:'outlook.body-content-type="text"',
      }
    },bytes);
  }
  return Object.freeze({
    id:'outlook',
    ready:Boolean(ready),
    async profile(accessTokenValue){
      return requestProvider(GRAPH_ROOT+'/me?$select=id,mail,userPrincipalName,displayName',{
        headers:{Authorization:'Bearer '+accessTokenValue}
      },64_000);
    },
    async listInbox({session,limit}){
      const path='/me/mailFolders/inbox/messages?'+
        new URLSearchParams({'$top':String(limit),'$select':INBOX_SELECT});
      const data=await graphGet(session,path);
      if(!data || !Array.isArray(data.value))throw graphError('Invalid Outlook inbox response');
      // Handles exist ONLY in this server session. A Graph message ID may be
      // much longer than our public mailbox message-ID contract permits.
      const map=new Map(), messages=[];
      for(const item of data.value.slice(0,limit)){
        if(typeof item?.id!=='string'||!RAW_ID.test(item.id))continue;
        const handle=randomBytes(18).toString('base64url');
        messages.push(graphEnvelope(item,session.email,handle));
        map.set(handle,item.id);
      }
      session.messageRefs=map;
      return {messages,nextPageAvailable:typeof data['@odata.nextLink']==='string'};
    },
    async readMessage({session,id}){
      if(!HANDLE.test(id))throw graphError('Invalid Outlook message handle',400);
      const raw=session.messageRefs instanceof Map ? session.messageRefs.get(id):null;
      if(!raw || !RAW_ID.test(raw))throw graphError('Outlook message is no longer in this session list',404);
      const path='/me/messages/'+encodeURIComponent(raw)+'?'+
        new URLSearchParams({'$select':DETAIL_SELECT});
      const item=await graphGet(session,path,1024*1024);
      if(item?.id!==raw)throw graphError('Microsoft Graph message mismatch');
      return {...graphEnvelope(item,session.email,id),body:graphPlainBody(item)};
    }
  });
}
