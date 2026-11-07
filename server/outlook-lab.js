/**
 * PhiMail R6: opt-in, loopback-only Microsoft personal-account OAuth bridge.
 * This is resource-provider authorization, NOT PhiID login or account linking.
 * Tokens and Graph identifiers live in volatile server memory, never React.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const MICROSOFT_AUTHORIZE='https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize';
export const MICROSOFT_TOKEN='https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
export const MICROSOFT_ORIGIN='http://127.0.0.1:5173';
export const MICROSOFT_CALLBACK=MICROSOFT_ORIGIN+'/auth/microsoft/callback';
const MICROSOFT_SCOPES='User.Read Mail.Read offline_access';
const FLOW_TTL=5*60_000;
const SESSION_TTL=4*60*60_000;
const MAX_FLOWS=64;
const MAX_SESSIONS=64;
function randomId(){return randomBytes(32).toString('base64url');}
function same(a,b){
  const x=Buffer.from(typeof a==='string'?a:''),y=Buffer.from(typeof b==='string'?b:'');
  return x.length===y.length&&timingSafeEqual(x,y);
}
function cookie(name,value,age,path){
  return name+'='+value+'; Path='+path+'; Max-Age='+age+'; HttpOnly; SameSite=Lax';
}
function parseCookie(req,name){
  let value=null;
  for(const part of String(req.headers.cookie||'').slice(0,8192).split(';')){
    const pos=part.indexOf('=');
    if(pos<0||part.slice(0,pos).trim()!==name)continue;
    if(value!==null)return null;
    const v=part.slice(pos+1).trim();
    if(!/^[A-Za-z0-9_-]{20,100}$/.test(v))return null;
    value=v;
  }
  return value;
}
function reply(res,status,data,cookies=[]){
  res.writeHead(status,{
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',
    ...(cookies.length?{'Set-Cookie':cookies}:{})
  });
  res.end(JSON.stringify(data));
}
function redirect(res,url,cookies=[]){
  res.writeHead(302,{
    Location:url,'Cache-Control':'no-store','Referrer-Policy':'no-referrer',
    ...(cookies.length?{'Set-Cookie':cookies}:{})
  });
  res.end();
}
function invalid(message,status=502){
  return Object.assign(new Error(message),{status});
}
export function validateMicrosoftToken(token,{refresh=false}={}){
  if(!token || typeof token!=='object' ||
    typeof token.access_token!=='string'||token.access_token.length<1||token.access_token.length>8192||
    String(token.token_type).toLowerCase()!=='bearer'||
    !Number.isFinite(Number(token.expires_in))||Number(token.expires_in)<=0||Number(token.expires_in)>86400||
    typeof token.scope!=='string'){
    throw invalid('Unusable Microsoft OAuth response');
  }
  const scopes=new Set(token.scope.toLowerCase().split(/\s+/));
  if(!scopes.has('mail.read')||!scopes.has('user.read')){
    throw invalid('Required Microsoft delegated read permissions were not granted',403);
  }
  if(token.refresh_token!==undefined&&
    (typeof token.refresh_token!=='string'||token.refresh_token.length<1||token.refresh_token.length>8192)){
    throw invalid('Invalid Microsoft refresh token');
  }
  return {
    accessToken:token.access_token,
    refreshToken:token.refresh_token||null,
    expiresIn:Number(token.expires_in)
  };
}
export function createMicrosoftLab({env=process.env,requestProvider,profile}){
  if(typeof requestProvider!=='function'||typeof profile!=='function'){
    throw new TypeError('Microsoft OAuth requires private server provider functions');
  }
  const enabled=env.BRIDGE_PUBLIC_ORIGIN===MICROSOFT_ORIGIN&&env.NODE_ENV!=='production';
  const clientId=env.MICROSOFT_CLIENT_ID||'';
  const secret=env.MICROSOFT_CLIENT_SECRET||'';
  const configured=enabled&&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)&&
    secret.length>0&&secret.length<=4096;
  const pending=new Map(),sessions=new Map(),rotations=new Map(),limits=new Map();
  function prune(){
    const now=Date.now();
    for(const [k,v] of pending)if(v.exp<=now)pending.delete(k);
    for(const [k,v] of sessions)if(v.expires<=now)sessions.delete(k);
    for(const [k,v] of rotations)if(!sessions.has(v))rotations.delete(k);
    for(const [k,v] of limits)if(v.until<=now)limits.delete(k);
  }
  function local(req){
    const peer=req.socket?.remoteAddress;
    return req.headers.host==='127.0.0.1:5173'&&
      (peer==='127.0.0.1'||peer==='::ffff:127.0.0.1');
  }
  function sessionFor(req){
    if(!configured||!local(req))return null;
    prune();
    const sid=parseCookie(req,'pm_ms_session');
    return sid?sessions.get(sid)||null:null;
  }
  async function accessToken(session){
    if(session.expires<=Date.now())throw invalid('Outlook session expired, please reconnect',401);
    if(session.accessExpires>Date.now()+30_000)return session.accessToken;
    if(!session.refreshToken)throw invalid('Outlook token expired, please reconnect',401);
    const data=await requestProvider(MICROSOFT_TOKEN,{
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({
        client_id:clientId,client_secret:secret,grant_type:'refresh_token',
        refresh_token:session.refreshToken,scope:MICROSOFT_SCOPES,
      })
    },64_000);
    const next=validateMicrosoftToken(data,{refresh:true});
    session.accessToken=next.accessToken;
    if(next.refreshToken)session.refreshToken=next.refreshToken;
    session.accessExpires=Date.now()+next.expiresIn*1000;
    return session.accessToken;
  }
  async function handle(req,res,path,url){
    if(path!=='/auth/microsoft/start'&&path!=='/auth/microsoft/callback')return false;
    prune();
    if(!configured){reply(res,503,{error:'microsoft_local_oauth_not_configured'});return true;}
    if(!local(req)){reply(res,403,{error:'loopback_origin_required'});return true;}
    if(req.method!=='GET'){reply(res,405,{error:'method_not_allowed'});return true;}

    if(path==='/auth/microsoft/start'){
      if(url.search){reply(res,400,{error:'unexpected_authorization_parameters'});return true;}
      const peer=req.socket.remoteAddress;
      const rate=limits.get(peer)||{count:0,until:Date.now()+600_000};
      rate.count+=1;limits.set(peer,rate);
      if(rate.count>8||pending.size>=MAX_FLOWS){reply(res,429,{error:'too_many_local_authorizations'});return true;}
      const flowId=randomId(),state=randomId(),verifier=randomId();
      const challenge=createHash('sha256').update(verifier).digest('base64url');
      pending.set(flowId,{state,verifier,exp:Date.now()+FLOW_TTL});
      const target=new URL(MICROSOFT_AUTHORIZE);
      for(const [k,v] of Object.entries({
        client_id:clientId,response_type:'code',redirect_uri:MICROSOFT_CALLBACK,
        response_mode:'query',scope:MICROSOFT_SCOPES,
        state,code_challenge:challenge,code_challenge_method:'S256'
      }))target.searchParams.set(k,v);
      redirect(res,target.href,[cookie('pm_ms_flow',flowId,300,'/auth/microsoft')]);
      return true;
    }
    if(String(req.url||'').length>8192){reply(res,400,{error:'invalid_microsoft_callback'});return true;}
    const flowId=parseCookie(req,'pm_ms_flow');
    const flow=flowId?pending.get(flowId):null;
    if(flowId)pending.delete(flowId);
    const clearFlow=cookie('pm_ms_flow','',0,'/auth/microsoft');
    if(!flow||flow.exp<=Date.now()||
       url.searchParams.getAll('state').length!==1||
       !same(url.searchParams.get('state'),flow.state)){
      reply(res,400,{error:'invalid_or_expired_microsoft_state'},[clearFlow]);return true;
    }
    if(url.searchParams.has('error')){
      redirect(res,MICROSOFT_ORIGIN+'/?outlook=denied',[clearFlow]);return true;
    }
    if(url.searchParams.getAll('code').length!==1 ||
       !url.searchParams.get('code')||url.searchParams.get('code').length>4096){
      reply(res,400,{error:'invalid_microsoft_code'},[clearFlow]);return true;
    }
    let tokens,me;
    try{
      const result=await requestProvider(MICROSOFT_TOKEN,{
        method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({
          client_id:clientId,client_secret:secret,grant_type:'authorization_code',
          code:url.searchParams.get('code'),redirect_uri:MICROSOFT_CALLBACK,
          code_verifier:flow.verifier,scope:MICROSOFT_SCOPES,
        })
      },64_000);
      tokens=validateMicrosoftToken(result);
      me=await profile(tokens.accessToken);
      const address=me?.mail||me?.userPrincipalName;
      if(typeof me?.id!=='string'||me.id.length>255||!me.id||
         typeof address!=='string'||address.length>320||
         !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))throw invalid('Invalid Microsoft Graph account profile');
    }catch{
      reply(res,401,{error:'microsoft_authorization_or_profile_failed'},[clearFlow]);return true;
    }
    const oldRotation=parseCookie(req,'pm_ms_rotation');
    const prior=oldRotation?rotations.get(oldRotation):null;
    if(oldRotation)rotations.delete(oldRotation);
    if(prior&&sessions.get(prior)?.rotation===oldRotation)sessions.delete(prior);
    if(sessions.size>=MAX_SESSIONS){reply(res,429,{error:'too_many_outlook_sessions'},[clearFlow]);return true;}
    const sid=randomId(),rotation=randomId();
    const now=Date.now();
    sessions.set(sid,{
      provider:'outlook',email:me.mail||me.userPrincipalName,
      accountId:me.id,accessToken:tokens.accessToken,refreshToken:tokens.refreshToken,
      accessExpires:now+tokens.expiresIn*1000,expires:now+SESSION_TTL,
      rotation,messageRefs:new Map()
    });
    rotations.set(rotation,sid);
    redirect(res,MICROSOFT_ORIGIN+'/?outlook=connected',[
      clearFlow,cookie('pm_ms_session',sid,Math.floor(SESSION_TTL/1000),'/api'),
      cookie('pm_ms_rotation',rotation,Math.floor(SESSION_TTL/1000),'/auth/microsoft')
    ]);
    return true;
  }
  // Pure server-side revocation for coordinated local disconnect.
  // The public route still enforces its own Origin and action headers.
  function revoke(req){
    const sid=parseCookie(req,'pm_ms_session');
    if(sid){
      const old=sessions.get(sid);
      if(old?.rotation)rotations.delete(old.rotation);
      sessions.delete(sid);
    }
  }
  function logout(req,res){
    if(!enabled||!local(req)){reply(res,403,{error:'local_outlook_session_only'});return;}
    if(req.headers.origin!==MICROSOFT_ORIGIN||
       req.headers['x-phimail-action']!=='disconnect-outlook'||
       req.headers['sec-fetch-site']==='cross-site'){
      reply(res,403,{error:'same_origin_outlook_disconnect_required'});return;
    }
    revoke(req);
    reply(res,200,{connected:false,provider:'outlook',remote_token_revoked:false},[
      cookie('pm_ms_session','',0,'/api'),
      cookie('pm_ms_rotation','',0,'/auth/microsoft')
    ]);
  }
  return {configured,handle,sessionFor,accessToken,logout,revoke};
}
