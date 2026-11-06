import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMailboxGateway, MAILBOX_SCHEMA, MAILBOX_READ_CAPABILITIES,
} from './mailbox-core.js';
import {
  createGmailReadAdapter, gmailPlainText, gmailEnvelope,
} from './providers/gmail.js';

const ISO='2026-11-06T12:00:00.000Z';
function good(id='msg1',provider='gmail'){
  return {
    id,threadId:'thread1',from:'Sender <sender@example.test>',
    email:'Sender <sender@example.test>',to:'receiver@example.test',
    subject:'Hello',date:ISO,preview:'Read only',
    unread:true,starred:false,labels:[],folder:'inbox',provider
  };
}
function adapter(id='gmail',changes={}){
  return {
    id,ready:true,
    async listInbox(){return {messages:[good('msg1',id)],nextPageAvailable:false};},
    async readMessage(){return {...good('msg1',id),body:'Safe plain text'};},
    ...changes
  };
}
const mailboxSession={provider:'gmail',email:'receiver@example.test'};

describe('PhiMail R5 generic mailbox gateway',()=>{
  it('exposes a versioned, read-only capability contract',()=>{
    assert.equal(MAILBOX_SCHEMA,'phimail.mailbox-read/0.1');
    assert.deepEqual([...MAILBOX_READ_CAPABILITIES],['read:inbox','read:message']);
    const gw=createMailboxGateway({adapters:[adapter()]});
    const providers=gw.catalog();
    assert.deepEqual(providers.map(p=>p.id),['gmail','outlook','imap']);
    assert.equal(providers[0].ready,true);
    assert.deepEqual(providers[0].capabilities,['read:inbox','read:message']);
    assert.equal(providers[1].ready,false);
    assert.deepEqual(providers[1].capabilities,[]);
    assert.equal(providers[2].ready,false);
    assert.deepEqual(providers[2].capabilities,[]);
    assert.equal(typeof gw.sendMessage,'undefined');
    assert.equal(typeof gw.deleteMessage,'undefined');
  });
  it('rejects malformed, duplicated and unapproved adapter registrations',()=>{
    assert.throws(()=>createMailboxGateway({adapters:[adapter(),adapter()]}),/Invalid/);
    assert.throws(()=>createMailboxGateway({adapters:[adapter('smtp')]}),/Invalid/);
    assert.throws(()=>createMailboxGateway({adapters:[{id:'gmail',ready:true}]}),/Invalid/);
    assert.throws(()=>createMailboxGateway({adapters:42}),/Adapters/);
  });
  it('does not treat a verified PhiID session as provider authorization',async()=>{
    const calls=[];
    const gw=createMailboxGateway({adapters:[adapter('gmail',{
      async listInbox(){calls.push('called');return {messages:[],nextPageAvailable:false};}
    })]});
    await assert.rejects(gw.listInbox({
      session:{authenticated:true,issuer:'https://phiid.example',sub:'valid-identity'},limit:15
    }),e=>e.status===401);
    assert.deepEqual(calls,[]);
  });
  it('requires explicit server-selected provider, never falls back to Gmail',async()=>{
    const gw=createMailboxGateway({adapters:[adapter()]});
    await assert.rejects(gw.listInbox({session:{provider:'outlook'},limit:10}),e=>e.status===503);
    await assert.rejects(gw.readMessage({session:{provider:'imap'},id:'msg1'}),e=>e.status===503);
    assert.equal((await gw.listInbox({session:mailboxSession,limit:10})).messages[0].provider,'gmail');
  });
  it('can normalize a synthetic Outlook adapter without claiming production support',async()=>{
    const gw=createMailboxGateway({adapters:[adapter('outlook')]});
    const result=await gw.listInbox({session:{provider:'outlook'},limit:10});
    assert.equal(result.messages[0].provider,'outlook');
    assert.equal(result.messages[0].subject,'Hello');
    assert.equal(gw.catalog().find(x=>x.id==='imap').ready,false);
    // This fake is injected only for unit tests. The production bridge wires Gmail alone.
  });
  it('enforces bounded limits and provider response shapes',async()=>{
    const gw=createMailboxGateway({adapters:[adapter()]});
    for(const limit of [0,21,1.5,'15',null]){
      await assert.rejects(gw.listInbox({session:mailboxSession,limit}),e=>e.status===400);
    }
    const malformed=createMailboxGateway({adapters:[adapter('gmail',{
      async listInbox(){return {messages:[{...good(),body:'<script>not an inbox envelope</script>',subject:'S'.repeat(550)}],nextPageAvailable:false};}
    })]});
    await assert.rejects(malformed.listInbox({session:mailboxSession,limit:15}),e=>e.status===502);
    const crowded=createMailboxGateway({adapters:[adapter('gmail',{
      async listInbox(){return {messages:[good(),good('msg2')],nextPageAvailable:false};}
    })]});
    await assert.rejects(crowded.listInbox({session:mailboxSession,limit:1}),e=>e.status===502);
  });
  it('rejects forged provider tags, malformed identifiers and mismatched details',async()=>{
    const wrongTag=createMailboxGateway({adapters:[adapter('gmail',{
      async listInbox(){return {messages:[good('msg1','outlook')],nextPageAvailable:false};}
    })]});
    await assert.rejects(wrongTag.listInbox({session:mailboxSession,limit:10}),e=>e.status===502);
    const gw=createMailboxGateway({adapters:[adapter()]});
    await assert.rejects(gw.readMessage({session:mailboxSession,id:'../secrets'}),e=>e.status===400);
    await assert.rejects(gw.readMessage({session:mailboxSession,id:'msg2'}),e=>e.status===502);
  });
  it('validates the final plain-text message body bound before returning it',async()=>{
    const tooLong=createMailboxGateway({adapters:[adapter('gmail',{
      async readMessage(){return {...good('msg1'),body:'X'.repeat(100_001)};}
    })]});
    await assert.rejects(tooLong.readMessage({session:mailboxSession,id:'msg1'}),e=>e.status===502);
    const gw=createMailboxGateway({adapters:[adapter()]});
    const full=await gw.readMessage({session:mailboxSession,id:'msg1'});
    assert.equal(full.body,'Safe plain text');
    assert.equal(full.provider,'gmail');
    assert.deepEqual(full.labels,[]);
  });
});
describe('Gmail provider adapter',()=>{
  it('fetches only fixed read-only Google URLs and emits the common contract',async()=>{
    const urls=[];
    const fake=async (url,options,maxBytes)=>{
      urls.push({url,options,maxBytes});
      assert.ok(String(url).startsWith('https://gmail.googleapis.com/gmail/v1/users/me/'));
      if(String(url).endsWith('/profile'))return {emailAddress:'user@example.test'};
      if(String(url).includes('/messages?'))return {messages:[{id:'msg1'}],nextPageToken:'next-page'};
      if(String(url).includes('format=metadata'))return {
        id:'msg1',threadId:'thread1',snippet:'Hello',internalDate:'1760000000000',
        labelIds:['UNREAD'],payload:{headers:[{name:'From',value:'Author <a@example.test>'},{name:'Subject',value:'Test'}]}
      };
      if(String(url).includes('format=full'))return {
        id:'msg1',internalDate:'1760000000000',payload:{
          mimeType:'multipart/alternative',parts:[
            {mimeType:'text/html',body:{data:Buffer.from('<img src="https://tracker.example">').toString('base64url')}},
            {mimeType:'text/plain',body:{data:Buffer.from('Hello from Google').toString('base64url')}},
          ]
        }
      };
      throw Error('Unexpected test URL '+url);
    };
    const a=createGmailReadAdapter({requestProvider:fake,accessToken:async()=> 'server-token',ready:true});
    assert.equal((await a.profile('server-token')).emailAddress,'user@example.test');
    const list=await a.listInbox({session:mailboxSession,limit:10});
    assert.equal(list.messages.length,1);
    assert.equal(list.messages[0].provider,'gmail');
    assert.equal(list.nextPageAvailable,true);
    const detail=await a.readMessage({session:mailboxSession,id:'msg1'});
    assert.equal(detail.body,'Hello from Google');
    assert.ok(!JSON.stringify(detail).includes('tracker.example'));
    assert.equal(urls.length,4);
    assert.equal(urls.every(x=>x.url.startsWith('https://gmail.googleapis.com/')),true);
    assert.equal(typeof a.sendMessage,'undefined');
  });
  it('keeps MIME traversal and raw identifiers bounded',async()=>{
    let nested={mimeType:'text/plain',body:{data:Buffer.from('hidden').toString('base64url')}};
    for(let i=0;i<20;i++)nested={mimeType:'multipart/mixed',parts:[nested]};
    assert.equal(gmailPlainText(nested),'');
    assert.equal(gmailPlainText({mimeType:'text/plain',body:{data:'A'.repeat(300_000)}}),'');
    assert.throws(()=>gmailEnvelope({id:'../bad'},'mail@example.test'),e=>e.status===502);
  });
});
