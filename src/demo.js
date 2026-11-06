export const DEMO_ADDRESS = 'you@demo.phimail.local';
export const seedMessages = [
{id:'m1',folder:'inbox',from:'PhiOS Field Team',email:'field@demo.phimail.local',to:DEMO_ADDRESS,subject:'Welcome to the open field',body:'Hey there,\n\nWelcome to PhiMail, your communication space in PhiOS.\n\nThis is fictional sample content, stored locally in your browser. No accounts are connected, and no email is sent to the internet.\n\nCommunication without captivity.\n\nThe PhiOS Team',date:'2026-11-06T19:10:00Z',unread:true,starred:true,labels:['Field Notes']},
{id:'m2',folder:'inbox',from:'PixelForge Studio',email:'studio@demo.phimail.local',to:DEMO_ADDRESS,subject:'Your new workspace is taking shape',body:'The new editor concept has a clean pipeline and performance space.\n\nNext we should measure actual runtime performance instead of relying on pretty sample numbers.\n\nThis is demo content.\n\n- PixelForge',date:'2026-11-06T17:45:00Z',unread:true,starred:false,labels:['Projects']},
{id:'m3',folder:'inbox',from:'Field Research',email:'research@demo.phimail.local',to:DEMO_ADDRESS,subject:'Less noise. More signal.',body:'What if a mailbox prioritized meaning over attention?\n\nWe could make sorting transparent, keep AI assistance opt-in, and let people export their messages.\n\nThis message is fictional.',date:'2026-11-05T21:03:00Z',unread:true,starred:true,labels:['Ideas']},
{id:'m4',folder:'inbox',from:'Break The Matrix',email:'updates@demo.phimail.local',to:DEMO_ADDRESS,subject:'Mission control checkpoint',body:'Mission priorities:\n\n- Keep movement independent of combat UI\n- Confirm weapon alignment\n- Make door cues readable\n\nThis is a sample message, not an update from a real account.',date:'2026-11-05T17:34:00Z',unread:false,starred:false,labels:['Projects']},
{id:'m5',folder:'inbox',from:'Infinite Porch',email:'porch@demo.phimail.local',to:DEMO_ADDRESS,subject:'A quiet place to think',body:'No tracking pixels. No engagement tricks. Just a calmer place for messages.\n\nA fictional demo note from the porch.',date:'2026-11-04T20:12:00Z',unread:false,starred:false,labels:['Field Notes']},
{id:'m6',folder:'inbox',from:'Open Standards Lab',email:'standards@demo.phimail.local',to:DEMO_ADDRESS,subject:'Interoperability is a feature',body:'Email survives because it connects people across services.\n\nReal integration will require server-side IMAP/SMTP or provider APIs, OAuth where appropriate, and serious security engineering. The first demo does not claim those capabilities.\n\nThis is simulated content.',date:'2026-11-03T17:22:00Z',unread:false,starred:true,labels:['Ideas']},
{id:'m7',folder:'inbox',from:'Design Lab',email:'design@demo.phimail.local',to:DEMO_ADDRESS,subject:'Make room for meaningful messages',body:'Generous whitespace, accessible controls, and a reading experience that makes people want to stay.\n\nThis message is fictional.',date:'2026-11-02T16:40:00Z',unread:false,starred:false,labels:['Design']},
{id:'m8',folder:'inbox',from:'PhiMail Laboratory',email:'lab@demo.phimail.local',to:DEMO_ADDRESS,subject:'A note about your privacy',body:'This prototype stores fictional messages in your browser localStorage, which is not encrypted.\n\nPlease do not import private email, enter credentials, or mistake demo Sent messages for actual delivery.\n\nReal accounts come later.',date:'2026-11-01T18:15:00Z',unread:false,starred:false,labels:['Field Notes']},
{id:'m9',folder:'sent',from:'You',email:DEMO_ADDRESS,to:'friend@demo.phimail.local',subject:'A note for tomorrow',body:'Here is an idea: a communication layer for PhiOS.\n\nThis is only fictional sample content. No email was ever delivered.',date:'2026-11-05T14:03:00Z',unread:false,starred:false,labels:[]},
{id:'m10',folder:'archive',from:'Community',email:'community@demo.phimail.local',to:DEMO_ADDRESS,subject:'Thanks for building in the open',body:'Open tools matter when people can actually use them.\n\nThis archived message is demo content.',date:'2026-10-30T18:20:00Z',unread:false,starred:false,labels:['Community']},
{id:'m11',folder:'drafts',from:'You',email:DEMO_ADDRESS,to:'',subject:'The future of independent mail',body:'What would communication look like if people owned the tools and the data?',date:'2026-11-06T12:00:00Z',unread:false,starred:false,labels:[]}
];
export const FOLDERS=['inbox','starred','sent','drafts','archive','trash'];
export function validateImportedMessages(data){
 if(!Array.isArray(data)||data.length>1000) throw new Error('Expected a list of up to 1,000 demo messages.');
 const ids=new Set();
 return data.map((m,i)=>{
  if(!m||typeof m!=='object'||Array.isArray(m)) throw new Error('Invalid message at index '+i);
  for(const k of ['id','folder','from','email','to','subject','body','date']) if(typeof m[k]!=='string'||m[k].length>30000) throw new Error('Invalid '+k+' at index '+i);
  if(!FOLDERS.includes(m.folder)||m.folder==='starred') throw new Error('Invalid folder');
  if(!Number.isFinite(Date.parse(m.date))) throw new Error('Invalid message date');
  if(ids.has(m.id)) throw new Error('Duplicate ID');
  ids.add(m.id);
  return {...m,id:m.id.slice(0,150),from:m.from.slice(0,200),email:m.email.slice(0,300),to:m.to.slice(0,500),subject:m.subject.slice(0,500),body:m.body.slice(0,30000),labels:Array.isArray(m.labels)?m.labels.filter(x=>typeof x==='string').slice(0,8).map(x=>x.slice(0,40)):[],unread:Boolean(m.unread),starred:Boolean(m.starred)};
 });
}
