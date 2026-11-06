/**
 * PhiMail R5 read-only mailbox adapter contract.
 *
 * The UI and HTTP routes never choose provider URLs or pass bearer tokens.
 * A server-owned OAuth session selects a compiled-in adapter. An OIDC
 * identity or consent-to-review receipt does not become a mail grant.
 */
export const MAILBOX_SCHEMA = 'phimail.mailbox-read/0.1';
export const MAILBOX_READ_CAPABILITIES = Object.freeze(['read:inbox','read:message']);
const PUBLIC_IDS = /^[A-Za-z0-9_-]{1,128}$/;
const CATALOG = Object.freeze([
  Object.freeze({ id:'gmail', name:'Gmail' }),
  Object.freeze({ id:'outlook', name:'Outlook' }),
  Object.freeze({ id:'imap', name:'IMAP' }),
]);

export class MailboxContractError extends Error {
  constructor(message,status=502){
    super(message);
    this.name='MailboxContractError';
    this.status=status;
  }
}
function isObject(value){
  return value!==null && typeof value==='object' && !Array.isArray(value);
}
function boundedText(value,max,field){
  if(typeof value!=='string' || value.length>max){
    throw new MailboxContractError('Invalid mailbox '+field);
  }
  return value;
}
function messageEnvelope(record,provider,allowBody=false){
  if(!isObject(record) || !PUBLIC_IDS.test(record.id||'')){
    throw new MailboxContractError('Invalid provider message identifier');
  }
  if(record.provider!==provider || record.folder!=='inbox' ||
     typeof record.unread!=='boolean' || typeof record.starred!=='boolean' ||
     !Array.isArray(record.labels) || record.labels.length!==0){
    throw new MailboxContractError('Invalid provider message metadata');
  }
  const date=boundedText(record.date,35,'date');
  if(!Number.isFinite(Date.parse(date)) || new Date(date).toISOString()!==date){
    throw new MailboxContractError('Invalid provider message date');
  }
  const normalized={
    id: record.id,
    threadId:record.threadId===null ? null : boundedText(record.threadId,128,'thread ID'),
    from:boundedText(record.from,320,'sender'),
    email:boundedText(record.email,320,'sender address'),
    to:boundedText(record.to,320,'recipient'),
    subject:boundedText(record.subject,500,'subject'),
    date,
    preview:boundedText(record.preview,1000,'preview'),
    unread:record.unread,
    starred:record.starred,
    labels:[],
    folder:'inbox',
    provider,
  };
  if(allowBody){
    normalized.body=boundedText(record.body,100_000,'plain-text body');
  }
  return normalized;
}
function requireAdapter(adapters,session){
  if(!isObject(session) || typeof session.provider!=='string'){
    throw new MailboxContractError('Connect a mailbox provider first',401);
  }
  const adapter=adapters.get(session.provider);
  if(!adapter || !adapter.ready){
    throw new MailboxContractError('Mailbox provider is unavailable',503);
  }
  return adapter;
}
/**
 * Each provider supplies:
 * { id, ready, listInbox({session,limit}), readMessage({session,id}) }
 * Exactly these read operations are dispatched. No send/delete/write API.
 */
export function createMailboxGateway({adapters=[]}={}){
  if(!Array.isArray(adapters))throw new TypeError('Adapters must be an array');
  const registered=new Map();
  for(const adapter of adapters){
    if(!isObject(adapter)||!CATALOG.some(x=>x.id===adapter.id)||
       registered.has(adapter.id)||typeof adapter.ready!=='boolean'||
       typeof adapter.listInbox!=='function'||typeof adapter.readMessage!=='function'){
      throw new TypeError('Invalid or duplicate mailbox adapter');
    }
    registered.set(adapter.id,adapter);
  }
  function catalog(){
    return CATALOG.map(item=>{
      const adapter=registered.get(item.id);
      return {
        id:item.id,
        name:item.name,
        ready:adapter?.ready===true,
        capabilities: adapter?.ready===true ? [...MAILBOX_READ_CAPABILITIES] :
          item.id==='gmail' && adapter ? [...MAILBOX_READ_CAPABILITIES] : [],
        connected:false,
      };
    });
  }
  async function listInbox({session,limit=15}){
    const adapter=requireAdapter(registered,session);
    if(!Number.isInteger(limit)||limit<1||limit>20){
      throw new MailboxContractError('Invalid inbox limit',400);
    }
    const result=await adapter.listInbox({session,limit});
    if(!isObject(result)||!Array.isArray(result.messages)||
       result.messages.length>limit||typeof result.nextPageAvailable!=='boolean'){
      throw new MailboxContractError('Invalid provider inbox response');
    }
    return {
      messages:result.messages.map(item=>messageEnvelope(item,adapter.id)),
      nextPageAvailable:result.nextPageAvailable,
    };
  }
  async function readMessage({session,id}){
    const adapter=requireAdapter(registered,session);
    if(typeof id!=='string'||!PUBLIC_IDS.test(id)){
      throw new MailboxContractError('Invalid message identifier',400);
    }
    const item=await adapter.readMessage({session,id});
    const normalized=messageEnvelope(item,adapter.id,true);
    if(normalized.id!==id){
      throw new MailboxContractError('Provider returned a different message identifier');
    }
    return normalized;
  }
  return Object.freeze({catalog,listInbox,readMessage});
}
