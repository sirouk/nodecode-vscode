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
