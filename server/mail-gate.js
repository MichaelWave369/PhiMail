/**
 * R9 experimental mail-request admission control.
 *
 * The minute counter and in-flight counters must be independent: a window
 * rollover may reset rate accounting, but it must NEVER erase work that is
 * still running. WeakMap keys keep counts provider-session scoped without
 * exposing account IDs or tokens.
 */
export const MAIL_RATE_WINDOW_MS=60_000;

export function createMailRequestGate({
  maxPerWindow=30,maxConcurrentPerSession=2,maxConcurrentGlobal=12,
  now=Date.now
}={}){
  if(![maxPerWindow,maxConcurrentPerSession,maxConcurrentGlobal].every(
    n=>Number.isSafeInteger(n)&&n>=1
  )||typeof now!=='function')throw new TypeError('Invalid mail gate configuration');

  const perSession=new WeakMap();
  let globalActive=0;
  function acquire(session){
    if(!session||typeof session!=='object')throw new TypeError('Session object required');
    const timestamp=now();
    if(!Number.isFinite(timestamp))throw new TypeError('Invalid mail gate clock');
    let state=perSession.get(session);
    if(!state){
      state={started:timestamp,count:0,active:0};
      perSession.set(session,state);
    }
    if(timestamp<state.started||timestamp-state.started>=MAIL_RATE_WINDOW_MS){
      state.started=timestamp;
      state.count=0;
      // DO NOT reset state.active: requests from the previous window exist.
    }
    if(state.count>=maxPerWindow||state.active>=maxConcurrentPerSession||
       globalActive>=maxConcurrentGlobal)return null;
    state.count+=1;
    state.active+=1;
    globalActive+=1;
    let released=false;
    return ()=>{
      if(released)return;
      released=true;
      state.active-=1;
      globalActive-=1;
    };
  }
  return Object.freeze({acquire});
}

/**
 * Provider refresh tokens can rotate. Serialize refreshes for the SAME
 * session only; other sessions remain independent. Always discard failures
 * so one transient provider error never poisons future retries.
 */
export function createSessionSingleFlight(){
  const pending=new WeakMap();
  return function run(session,operation){
    if(!session||typeof session!=='object'||typeof operation!=='function')
      throw new TypeError('Single-flight requires session and operation');
    const current=pending.get(session);
    if(current)return current;
    // Store before executing the operation; synchronous callers share it.
    const promise=Promise.resolve().then(operation);
    pending.set(session,promise);
    // A handler is installed on both fulfillment and rejection; all callers
    // get the original promise and no detached rejected promise is created.
    const cleanup=()=>{if(pending.get(session)===promise)pending.delete(session);};
    promise.then(cleanup,cleanup);
    return promise;
  };
}
