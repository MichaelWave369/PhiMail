/**
 * R7 local preconfigured IMAP account opt-in.
 *
 * The browser sends ONLY a separate high-entropy local unlock phrase.
 * Server IMAP host/user/password remain process environment secrets.
 * This is NOT multi-user authentication, SSO, or a hosted mail service.
 */
import { randomBytes,timingSafeEqual } from 'node:crypto';

const ORIGIN='http://127.0.0.1:5173';
const SESSION_MS=20*60_000;
const MAX_BODY=512;
const MAX_SESSIONS=8;
const MAX_ATTEMPTS=5;
const RATE_MS=10*60_000;
function token(){return randomBytes(32).toString('base64url');}
function secretEqual(a,b){
  const left=Buffer.from(typeof a==='string'?a:''),right=Buffer.from(typeof b==='string'?b:'');
  return left.length===right.length&&timingSafeEqual(left,right);
}
function parseSessionCookie(req){
  let id=null;
  for(const part of String(req.headers.cookie||'').slice(0,8192).split(';')){
    const i=part.indexOf('=');
    if(i<0||part.slice(0,i).trim()!=='pm_imap_session')continue;
    if(id!==null)return null;
    const value=part.slice(i+1).trim();
    if(!/^[A-Za-z0-9_-]{20,100}$/.test(value))return null;
    id=value;
  }
  return id;
}
function local(req){
  const peer=req.socket?.remoteAddress;
  return req.headers.host==='127.0.0.1:5173'&&
    (peer==='127.0.0.1'||peer==='::ffff:127.0.0.1');
}
function cookie(value,age){
  return 'pm_imap_session='+value+'; Path=/api; Max-Age='+age+'; HttpOnly; SameSite=Lax';
}
function reply(res,status,data,extra={}){
  res.writeHead(status,{
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store',
    'Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',
    'X-Content-Type-Options':'nosniff',...extra
  });
  res.end(JSON.stringify(data));
}
async function parseUnlock(req){
  if(req.headers['content-type']!=='application/json'){
    throw Object.assign(new Error('json_required'),{status:415});
  }
  const len=req.headers['content-length'];
  if(len!==undefined && (!/^\d+$/.test(len)||Number(len)>MAX_BODY)){
    throw Object.assign(new Error('payload_too_large'),{status:413});
  }
  let size=0;const parts=[];
  for await(const chunk of req){
    size+=chunk.length;
    if(size>MAX_BODY)throw Object.assign(new Error('payload_too_large'),{status:413});
    parts.push(chunk);
  }
  let parsed;
  try{parsed=JSON.parse(Buffer.concat(parts).toString('utf8'));}
  catch{throw Object.assign(new Error('invalid_json'),{status:400});}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||
     Object.keys(parsed).join(',')!=='unlock'||
     typeof parsed.unlock!=='string'||parsed.unlock.length<1||parsed.unlock.length>256){
    throw Object.assign(new Error('local_unlock_required'),{status:400});
  }
  return parsed.unlock;
}
export function createImapLab({env=process.env,adapter}){
  if(!adapter || typeof adapter.probe!=='function')throw new TypeError('IMAP lab requires a server adapter');
  const configured=adapter.ready===true;
  const sessions=new Map(),attempts=new Map();
  function prune(){
    const now=Date.now();
    for(const [id,s] of sessions)if(s.expires<=now)sessions.delete(id);
    for(const [id,entry] of attempts)if(entry.until<=now)attempts.delete(id);
  }
  function sessionFor(req){
    if(!configured||!local(req))return null;
    prune();
    const sid=parseSessionCookie(req);
    return sid?sessions.get(sid)||null:null;
  }
  async function handle(req,res,path){
    if(path!=='/api/imap/connect')return false;
    prune();
    if(!configured){reply(res,503,{error:'local_imap_not_configured'});return true;}
    if(!local(req)){reply(res,403,{error:'loopback_only'});return true;}
    if(req.method!=='POST'){reply(res,405,{error:'method_not_allowed'});return true;}
    if(req.headers.origin!==ORIGIN||
       req.headers['x-phimail-action']!=='connect-imap'||
       req.headers['sec-fetch-site']==='cross-site'){
      reply(res,403,{error:'same_origin_imap_action_required'});return true;
    }
    const peer=req.socket.remoteAddress;
    const rate=attempts.get(peer)||{count:0,until:Date.now()+RATE_MS};
    rate.count+=1;attempts.set(peer,rate);
    if(rate.count>MAX_ATTEMPTS){reply(res,429,{error:'too_many_local_unlock_attempts'});return true;}
    let unlock;
    try{unlock=await parseUnlock(req);}
    catch(error){reply(res,error.status||400,{error:error.message});return true;}
    if(!secretEqual(unlock,env.IMAP_UNLOCK_KEY)){
      reply(res,401,{error:'local_imap_unlock_denied'});return true;
    }
    if(sessions.size>=MAX_SESSIONS){
      reply(res,429,{error:'local_imap_session_limit'});return true;
    }
    try{await adapter.probe();}
    catch{reply(res,503,{error:'imap_connection_unavailable'});return true;}
    // An explicit successful local unlock is the only authorization for this
    // server-configured mailbox. Reuse never implies PhiID account ownership.
    const prior=parseSessionCookie(req);
    if(prior)sessions.delete(prior);
    const sid=token();
    sessions.set(sid,{
      provider:'imap',email:env.IMAP_USERNAME,
      expires:Date.now()+SESSION_MS,
      messageRefs:new Map(),
      mailBudget:null,
    });
    attempts.delete(peer);
    reply(res,200,{connected:true,provider:'imap',email:env.IMAP_USERNAME,
      access:'local_read_only',phiid_linked:false},{
      'Set-Cookie':cookie(sid,Math.floor(SESSION_MS/1000))
    });
    return true;
  }
  // Only the containing bridge may call this after validating the bulk action.
  function revoke(req){
    const id=parseSessionCookie(req);
    if(id)sessions.delete(id);
  }
  function logout(req,res){
    if(!configured||!local(req)){reply(res,403,{error:'local_imap_only'});return;}
    if(req.headers.origin!==ORIGIN||
       req.headers['x-phimail-action']!=='disconnect-imap'||
       req.headers['sec-fetch-site']==='cross-site'){
      reply(res,403,{error:'same_origin_imap_disconnect_required'});return;
    }
    revoke(req);
    reply(res,200,{connected:false,provider:'imap',server_credential_revoked:false},{
      'Set-Cookie':cookie('',0)
    });
  }
  return Object.freeze({configured,sessionFor,handle,logout,revoke});
}
