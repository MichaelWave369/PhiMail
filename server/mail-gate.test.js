import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {createMailRequestGate,createSessionSingleFlight} from './mail-gate.js';

describe('R9 provider-session mail gate',()=>{
  it('allows 30 sequential operations per minute and rejects excess',()=>{
    let clock=1000;
    const gate=createMailRequestGate({now:()=>clock});
    const session={provider:'gmail'};
    for(let i=0;i<30;i++){
      const done=gate.acquire(session);
      assert.equal(typeof done,'function');
      done();
      done(); // idempotent: an accidental repeated cleanup cannot erase a slot
    }
    assert.equal(gate.acquire(session),null);
    clock+=60_000;
    const next=gate.acquire(session);
    assert.equal(typeof next,'function');
    next();
  });
  it('does not drop active concurrency across minute window rollover',()=>{
    let clock=0;
    const gate=createMailRequestGate({
      now:()=>clock,maxPerWindow:5,maxConcurrentPerSession:2,
      maxConcurrentGlobal:12
    });
    const session={provider:'outlook'};
    const a=gate.acquire(session),b=gate.acquire(session);
    assert.ok(a&&b);
    assert.equal(gate.acquire(session),null);
    clock=60_001;
    // rate counter reset; active requests MUST still occupy their slots.
    assert.equal(gate.acquire(session),null);
    a();
    const c=gate.acquire(session);
    assert.ok(c);
    assert.equal(gate.acquire(session),null);
    b();c();
  });
  it('bounds all provider sessions globally without mixing their counters',()=>{
    let clock=0;
    const gate=createMailRequestGate({
      now:()=>clock,maxPerWindow:10,
      maxConcurrentPerSession:2,maxConcurrentGlobal:3
    });
    const a={},b={},c={};
    const releaseA=gate.acquire(a),releaseB=gate.acquire(b),releaseC=gate.acquire(c);
    assert.ok(releaseA&&releaseB&&releaseC);
    assert.equal(gate.acquire(c),null);
    assert.equal(gate.acquire({}),null);
    releaseA();
    assert.ok(gate.acquire(c));
    releaseB();releaseC();
  });
  it('preserves per-session budgets independently on clock changes',()=>{
    let clock=120_000;
    const gate=createMailRequestGate({now:()=>clock,maxPerWindow:1});
    const a={},b={};
    const first=gate.acquire(a);
    first();
    assert.equal(gate.acquire(a),null);
    const second=gate.acquire(b);
    assert.ok(second);second();
    clock=10; // clock correction resets rate counter but not active slots
    const third=gate.acquire(a);
    assert.ok(third);third();
  });
  it('rejects malformed construction and invalid sessions',()=>{
    assert.throws(()=>createMailRequestGate({maxConcurrentGlobal:0}),TypeError);
    assert.throws(()=>createMailRequestGate({now:null}),TypeError);
    assert.throws(()=>createMailRequestGate().acquire('not-a-session'),TypeError);
  });
});

describe('R9 session-bound refresh single-flight',()=>{
  it('shares one in-flight token request among concurrent readers',async()=>{
    const run=createSessionSingleFlight();
    const session={provider:'gmail'};
    let count=0,release;
    const blocked=new Promise(r=>{release=r;});
    const operation=async()=>{count++;await blocked;return 'refreshed';};
    const a=run(session,operation),b=run(session,operation),c=run(session,operation);
    assert.equal(a,b);assert.equal(b,c);
    release();
    assert.deepEqual(await Promise.all([a,b,c]),['refreshed','refreshed','refreshed']);
    assert.equal(count,1);
    const after=await run(session,operation);
    assert.equal(after,'refreshed');
    assert.equal(count,2);
  });
  it('does not serialize unrelated Outlook and Gmail sessions',async()=>{
    const run=createSessionSingleFlight();
    const a={},b={};
    let aCount=0,bCount=0;
    const results=await Promise.all([
      run(a,async()=>++aCount),
      run(b,async()=>++bCount)
    ]);
    assert.deepEqual(results,[1,1]);
    assert.equal(aCount,1);assert.equal(bCount,1);
  });
  it('removes a rejected refresh so retry can succeed',async()=>{
    const run=createSessionSingleFlight();
    const session={};
    let calls=0;
    const fails=()=>{calls++;throw new Error('transient failure');};
    const first=run(session,fails),second=run(session,fails);
    assert.equal(first,second);
    await assert.rejects(first,/transient failure/);
    await assert.rejects(second,/transient failure/);
    assert.equal(calls,1);
    // Promise reaction cleanup may be scheduled as a microtask.
    const value=await run(session,async()=>{calls++;return 'fresh';});
    assert.equal(value,'fresh');
    assert.equal(calls,2);
  });
});
