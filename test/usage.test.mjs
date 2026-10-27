import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {SessionStore}=require('../out/store.js');
const fact=(sequence,type,payload={},sessionId='own')=>({type:'session_stream_event',session_id:sessionId,sequence,event:{type,payload}});
const replay=(frames,fields={})=>({type:'session_stream_resumed',session_id:'own',accumulated_frames:frames,replay_chunk_final:true,admission_state:'ready',...fields});
const usage=(sequence,counts,sessionId='own')=>fact(sequence,'turn.usage',counts,sessionId);
const round={'input-tokens':1000,'output-tokens':100,'cached-input-tokens':2000,'cache-write-tokens':300};
const tokenFields=view=>({input:view.totals.input,output:view.totals.output,cached:view.totals.cached,cacheWrite:view.totals.cacheWrite,total:view.totals.total});
const ownStore=()=>{const store=new SessionStore();store.setThreads([],'own');return store;};

test('visible token spend sums disjoint native counts, not provider-specific total or overlapping breakdowns',()=>{
  for(const reportedTotal of [undefined,1100,3400]){
    const store=ownStore();
    store.applyFrame(usage(1,{...round,...(reportedTotal===undefined?{}:{'total-tokens':reportedTotal}),'reasoning-tokens':75,'cache-write-5m-tokens':100,'cache-write-1h-tokens':200}));
    assert.deepEqual(tokenFields(store.view()),{input:1000,output:100,cached:2000,cacheWrite:300,total:3400});
    assert.deepEqual(store.view().contextUsage,{input:1000,cached:2000,cacheWrite:300});
  }
});

test('all paid visible rounds accumulate, including voided or estimated attempts, while context remains the newest round',()=>{
  const store=ownStore();
  store.applyFrames([
    usage(1,{...round,voided:true,cost_known:true,cost_usd:0.75}),
    usage(2,{'input-tokens':200,'output-tokens':50,'cached-input-tokens':1500,'cache-write-tokens':250,estimated:true,cost_known:false,cost_usd:999}),
  ]);
  assert.deepEqual(tokenFields(store.view()),{input:1200,output:150,cached:3500,cacheWrite:550,total:5400});
  assert.deepEqual(store.view().contextUsage,{input:200,cached:1500,cacheWrite:250});
  assert.equal(store.view().totals.costKnown,true);
  assert.equal(store.view().totals.costUsd,0.75,'unknown prices are not included in the recorded cost');
});

test('authoritative headers clear omitted counters, context, and prices rather than retain stale fields',()=>{
  const store=ownStore();
  store.applyFrame(usage(1,{...round,cost_known:true,cost_usd:0.75}));
  store.applyHeader({session_id:'own',through:2,session_usage:{input:5,output:7,total:999},context_usage:{input:5}});
  assert.deepEqual(tokenFields(store.view()),{input:5,output:7,cached:0,cacheWrite:0,total:12});
  assert.deepEqual(store.view().contextUsage,{input:5,cached:0,cacheWrite:0});
  assert.equal(store.view().totals.costKnown,false);assert.equal(store.view().totals.costUsd,0);
  store.applyHeader({session_id:'own',through:3,session_usage:{},context_usage:{}});
  assert.deepEqual(tokenFields(store.view()),{input:0,output:0,cached:0,cacheWrite:0,total:0});
  assert.deepEqual(store.view().contextUsage,{input:0,cached:0,cacheWrite:0});
});

test('inherited full-history usage never becomes this session bill or blocks its empty own header',()=>{
  const store=ownStore();
  store.applyFrame(replay([
    fact(1,'session.created',{id:'ancestor'}),
    fact(2,'turn.input_committed',{message:'Inherited question'}),
    usage(3,{...round,cost_known:true,cost_usd:0.75}),
    fact(4,'turn.assistant_message_completed',{message:{content:'Inherited answer'}}),
  ],{cursor:0}));
  store.applyHeader({session_id:'own',through:0,session_usage:{},context_usage:{}});
  assert.deepEqual(tokenFields(store.view()),{input:0,output:0,cached:0,cacheWrite:0,total:0});
  assert.deepEqual(store.view().contextUsage,{input:0,cached:0,cacheWrite:0});
  assert.equal(store.view().totals.costKnown,false);
  assert.equal(store.view().parts.length,2,'inherited transcript remains visible even though usage is own-session only');
});

test('ancestry and own-session header retain only own counters and reject a different session header',()=>{
  const store=ownStore();
  store.applyFrame(replay([
    fact(1,'session.created',{id:'ancestor'}),usage(2,{...round,cost_known:true,cost_usd:0.75}),
    fact(3,'session.created',{id:'own'}),usage(4,{'input-tokens':10,'output-tokens':5}),
  ],{cursor:4}));
  store.applyHeader({session_id:'own',through:4,session_usage:{input:10,output:5},context_usage:{input:10}});
  assert.deepEqual(tokenFields(store.view()),{input:10,output:5,cached:0,cacheWrite:0,total:15});
  const before=structuredClone(store.view());
  store.applyHeader({session_id:'ancestor',through:999,session_usage:{input:999,output:999},context_usage:{input:999}});
  assert.deepEqual(store.view(),before);
});

test('a header received between replay chunks covers old rounds without hiding transcript or suppressing newer usage',()=>{
  const store=ownStore();
  let updates=0;store.subscribe(()=>updates++);
  store.applyFrame(replay([fact(1,'session.created',{id:'own'}),usage(2,round)],{replay_chunk_index:0,replay_chunk_final:false}));
  store.applyHeader({session_id:'own',through:8,session_usage:{input:1200,output:150,cached:3500,cache_write:550,total:1350,cost_known:true,cost:0.75},context_usage:{input:200,cached:1500,cache_write:250}});
  assert.equal(updates,0,'a replay/header interleave must not publish a partial transcript or its provisional counters');
  store.applyFrame(replay([fact(7,'turn.assistant_message_completed',{message:{content:'Complete'}}),usage(8,{'input-tokens':200,'output-tokens':50,'cached-input-tokens':1500,'cache-write-tokens':250})],{replay_chunk_index:1,cursor:8}));
  assert.equal(updates,1);
  assert.deepEqual(tokenFields(store.view()),{input:1200,output:150,cached:3500,cacheWrite:550,total:5400});
  assert.equal(store.view().parts[0].text,'Complete');
  store.applyFrame(usage(9,{'input-tokens':10,'output-tokens':2,'cache-write-tokens':3}));
  const before=structuredClone(store.view());
  store.applyHeader({session_id:'own',through:8,session_usage:{input:1200,output:150,cached:3500,cache_write:550},context_usage:{input:200,cached:1500,cache_write:250}});
  assert.deepEqual(store.view().totals,before.totals);assert.deepEqual(store.view().contextUsage,before.contextUsage);
  assert.equal(store.view().totals.total,5415);
});

test('checkpoint restore with duplicate and delta replay counts each provider round once',()=>{
  const original=ownStore();
  original.applyFrame(replay([fact(1,'session.created',{id:'own'}),usage(2,round),fact(3,'turn.assistant_message_completed',{message:{content:'Original'}})],{cursor:3}));
  original.applyHeader({session_id:'own',through:2,session_usage:{input:1000,output:100,cached:2000,cache_write:300,cost_known:true,cost:0.75},context_usage:{input:1000,cached:2000,cache_write:300}});
  const restored=new SessionStore();restored.restoreProjection(JSON.parse(JSON.stringify(original.snapshotProjection())),'own');
  assert.equal(restored.view().cached,true);assert.equal(restored.view().replayComplete,false);
  const catchup=replay([usage(2,round),fact(3,'turn.assistant_message_completed',{message:{content:'Duplicate'}}),usage(4,{'input-tokens':200,'output-tokens':50,'cached-input-tokens':1500,'cache-write-tokens':250}),fact(5,'turn.assistant_message_completed',{message:{content:'New'}})],{resumed_after:3,cursor:5});
  original.applyFrame(catchup);restored.applyFrame(catchup);
  for(const key of ['parts','totals','contextUsage'])assert.deepEqual(restored.view()[key],original.view()[key],key);
  assert.equal(restored.view().totals.total,5400);
  assert.equal(restored.view().totals.turns,2);
  assert.equal(restored.view().parts.length,2);
});

test('a full branch replacement after checkpoint restore replaces usage instead of adding it',()=>{
  const original=ownStore();
  original.applyFrame(replay([fact(1,'session.created',{id:'own'}),usage(2,round),fact(3,'turn.assistant_message_completed',{message:{content:'Discarded branch'}})],{cursor:3}));
  const restored=new SessionStore();restored.restoreProjection(JSON.parse(JSON.stringify(original.snapshotProjection())),'own');
  const replacement=replay([fact(1,'session.created',{id:'own'}),usage(2,{'input-tokens':4,'output-tokens':2}),fact(4,'turn.assistant_message_completed',{message:{content:'Current branch'}})],{cursor:4});
  restored.applyFrame(replacement);original.applyFrame(replacement);
  for(const key of ['parts','totals','contextUsage'])assert.deepEqual(restored.view()[key],original.view()[key],key);
  assert.deepEqual(tokenFields(restored.view()),{input:4,output:2,cached:0,cacheWrite:0,total:6});
});

test('ambiguous ancestry usage in a native fast tail remains provisional and full replay replaces it',()=>{
  const store=ownStore();let updates=0;store.subscribe(()=>updates++);
  // Native first-pass seeds usage without session.created ancestry boundaries.
  store.applyFrame(replay([usage(3,{...round,cost_known:true,cost_usd:0.75}),fact(20,'turn.input_committed',{message:'Tail prompt'})],{replay_tail:true,replay_chunk_index:0,cursor:20}));
  assert.equal(updates,0);assert.equal(store.view().replayComplete,false);
  store.applyHeader({session_id:'own',through:0,session_usage:{},context_usage:{}});
  assert.equal(updates,0,'the provisional fold must not expose ancestor counters');
  store.applyFrame(replay([fact(1,'session.created',{id:'ancestor'}),usage(3,round),fact(4,'turn.input_committed',{message:'Inherited'}),fact(20,'session.created',{id:'own'})],{replay_chunk_index:0,cursor:20}));
  store.applyHeader({session_id:'own',through:0,session_usage:{},context_usage:{}});
  assert.deepEqual(tokenFields(store.view()),{input:0,output:0,cached:0,cacheWrite:0,total:0});
  assert.deepEqual(store.view().contextUsage,{input:0,cached:0,cacheWrite:0});
});
