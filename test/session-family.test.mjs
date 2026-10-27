import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {sessionFamily}=require('../out/session-family.js');
const {SessionStore}=require('../out/store.js');
const {SessionController}=require('../out/manager.js');
const rows=[
  {id:'root',title:'Root'},
  {id:'parent',title:'Parent',parent_id:'root',source:'fork',relation:'inherited'},
  {id:'child',title:'Child',parent_id:'parent',source:'fork',relation:'inherited'},
  {id:'grandchild',title:'Grandchild',parent_id:'child',source:'fork',relation:'inherited'},
  {id:'manual',title:'Manual fork',parent_id:'parent',source:'rpc',relation:'inherited'},
  {id:'separate',title:'Separate root'},
];

test('native hierarchy preserves ancestors, siblings, descendants and source-defined delegation',()=>{
  const family=sessionFamily(rows,'child',new Map([['grandchild','2026-10-26T12:00:00Z']]));
  assert.deepEqual(family.ancestors.map(r=>[r.id,r.relativeDepth]),[['root',-2],['parent',-1]]);
  assert.deepEqual(family.siblings.map(r=>[r.id,r.kind]),[['manual','history-fork']]);
  assert.deepEqual(family.descendants.map(r=>[r.id,r.status,r.startedAt]),[['grandchild','running','2026-10-26T12:00:00Z']]);
  assert.equal(family.threads[0].kind,'subagent');
  assert.equal(sessionFamily(rows,'root',new Map()).siblings.length,0);
  assert.deepEqual(sessionFamily(rows,'root').descendants.map(r=>r.id),['parent','child','grandchild','manual']);
});

test('the current thread is described with its native parent and activity, including after cache restore',()=>{
  const family=sessionFamily(rows,'child',new Map());
  assert.equal(family.currentThread?.id,'child');
  assert.equal(family.currentThread.parentId,'parent');
  assert.equal(family.currentThread.relativeDepth,0);
  assert.equal(family.currentThread.status,'idle');
  assert.equal(sessionFamily(rows,'missing').currentThread,undefined);
  const store=new SessionStore();store.applyFrame({type:'session_stream_resumed',session_id:'child',replay_chunk_final:true,admission_state:'ready',accumulated_frames:[]});store.setThreads(rows,'child');
  assert.equal(store.view().currentThread.id,'child');
  const restored=new SessionStore();restored.restoreProjection(JSON.parse(JSON.stringify(store.snapshotProjection())),'child');
  assert.equal(restored.view().currentThread.id,'child');
  assert.equal(restored.view().currentThread.status,'unknown');
});

test('status distinguishes unavailable activity, running, asked and failed without inventing completion',()=>{
  const rows=[{id:'a',parent_id:'r',waits:{why:'asked'}},{id:'b',parent_id:'r',waits:{why:'failed'}},{id:'c',parent_id:'r'}];
  assert.deepEqual(sessionFamily(rows,'r').threads.map(r=>r.status),['waiting','failed','unknown']);
  assert.deepEqual(sessionFamily(rows,'r',new Map([['b',undefined]])).threads.map(r=>r.status),['waiting','running','idle']);
  const store=new SessionStore();store.setThreads(rows,'r');
  store.applyFrame({type:'organism.activity',sessions:[{id:'b',started_at:'now'}]});
  assert.equal(store.view().threads[1].startedAt,'now');
  store.applyFrame({type:'organism.activity',sessions:[]});
  assert.equal(store.view().threads[1].status,'failed');
});

test('malformed cycle and missing parent never fabricate nodes or recurse forever',()=>{
  const cycle=sessionFamily([{id:'a',parent_id:'b'},{id:'b',parent_id:'a'}],'a');
  assert.deepEqual(cycle.ancestors.map(r=>r.id),['b']);
  assert.deepEqual(cycle.descendants.map(r=>r.id),['b']);
  assert.deepEqual(sessionFamily([{id:'a',parent_id:'missing'}],'a').ancestors,[]);
});

test('late directory response cannot replace a newer native family snapshot',async()=>{
  const pending=[];
  const controller=new SessionController({}, {log(){}}, {sessions:()=>new Promise(resolve=>pending.push(resolve))},'', 'root');
  controller.refreshThreads();controller.refreshThreads();
  pending[1](rows);await Promise.resolve();
  pending[0]([]);await Promise.resolve();
  assert.equal(controller.store.view().threads[0].id,'parent');
  controller.dispose();
});


test('family timestamps preserve native creation and last-activity recency through cache restore',()=>{
  const rows=[{id:'root'},{id:'child',parent_id:'root',source:'fork',created_at:'2026-10-25T08:00:00Z',updated_at:'2026-10-26T17:00:00Z'}];
  const store=new SessionStore();store.applyFrame({type:'session_stream_resumed',session_id:'root',replay_chunk_final:true,admission_state:'ready',accumulated_frames:[]});store.setThreads(rows,'root');
  store.applyFrame({type:'organism.activity',sessions:[{id:'child',started_at:'2026-10-26T16:00:00Z'}]});
  const active=store.view().threads[0];
  assert.equal(active.createdAt,rows[1].created_at);assert.equal(active.updatedAt,rows[1].updated_at);
  assert.equal(active.startedAt,'2026-10-26T16:00:00Z');
  const restored=new SessionStore();restored.restoreProjection(JSON.parse(JSON.stringify(store.snapshotProjection())),'root');
  assert.equal(restored.view().threads[0].status,'unknown','cached activity must not claim a thread is idle or running');
  assert.equal(restored.view().threads[0].createdAt,active.createdAt);assert.equal(restored.view().threads[0].updatedAt,active.updatedAt);
  store.applyFrame({type:'organism.activity',sessions:[]});
  assert.equal(store.view().threads[0].status,'idle');assert.equal(store.view().threads[0].startedAt,undefined);
  assert.equal(store.view().threads[0].updatedAt,rows[1].updated_at,'last activity is not a fabricated idle-transition timestamp');
});

test('new delegated forks produce one concise spawned notice and retain its identity through cached reopen',()=>{
  const store=new SessionStore(),baseline=[{id:'root'},{id:'existing',parent_id:'root',source:'fork',title:'Existing'}];
  store.applyFrame({type:'session_stream_resumed',session_id:'root',replay_chunk_final:true,admission_state:'ready',accumulated_frames:[]});
  store.setThreads(baseline,'root');
  assert.equal(store.view().parts.filter(part=>part.childSessionId).length,0,'opening an existing roster is not a spawn');
  const draft={id:'new',parent_id:'root',title:'Fresh fork'};
  store.setThreads([...baseline,draft],'root');
  assert.equal(store.view().parts.filter(part=>part.childSessionId).length,0,'only native delegated source confirms a spawn');
  const spawned={...draft,source:'fork'};
  store.setThreads([...baseline,spawned],'root');store.setThreads([...baseline,{...spawned,title:'Renamed fork'}],'root');
  const notices=store.view().parts.filter(part=>part.childSessionId);
  assert.deepEqual(notices,[{kind:'system',text:'Spawned: Fresh fork',level:'info',childSessionId:'new'}]);
  const restored=new SessionStore();restored.restoreProjection(JSON.parse(JSON.stringify(store.snapshotProjection())),'root');
  restored.setThreads([...baseline,spawned],'root');
  assert.deepEqual(restored.view().parts.filter(part=>part.childSessionId),notices,'cache restoration must not repeat a spawn notice');
});
