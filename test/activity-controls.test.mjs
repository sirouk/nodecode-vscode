import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const {THREAD_ORDER_JS}=require('../out/activity-controls.js');
const context=vm.createContext({});
const ids=rows=>Array.from(rows,row=>row.id);
const at=hour=>'2026-10-26T'+String(hour).padStart(2,'0')+':00:00Z';

function groups(rows){
  assert.equal(typeof THREAD_ORDER_JS,'string','thread ordering must use the same helper in tests and the webview');
  vm.runInContext(THREAD_ORDER_JS,context);
  return context.threadGroups(rows);
}

test('active threads use newest start first while one recently updated idle thread remains visible',()=>{
  const rows=[
    {id:'old-idle',status:'idle',createdAt:at(9),updatedAt:at(10)},
    {id:'running-old',status:'running',startedAt:at(11),createdAt:at(8)},
    {id:'recent-idle',status:'idle',createdAt:at(6),updatedAt:at(17)},
    {id:'running-new',status:'running',startedAt:at(16),createdAt:at(5)},
    {id:'waiting',status:'waiting',createdAt:at(15)},
    {id:'unknown',status:'unknown',createdAt:at(14)},
    {id:'failed',status:'failed',createdAt:at(13)},
    {id:'middle-idle',status:'idle',createdAt:at(12),updatedAt:at(12)},
  ];
  const before=structuredClone(rows),result=groups(rows);
  assert.deepEqual(ids(result.active),['running-new','waiting','unknown','failed','running-old','recent-idle']);
  assert.deepEqual(ids(result.idle),['middle-idle','old-idle']);
  assert.deepEqual(rows,before,'sorting must not mutate the authoritative family projection');
  assert.equal(new Set(ids(result.active).concat(ids(result.idle))).size,rows.length,'each thread appears exactly once');
});

test('thread ordering uses creation only when its status-specific timestamp is absent and retains native tie order',()=>{
  const result=groups([
    {id:'active-tie-a',status:'running',startedAt:at(16),updatedAt:at(19)},
    {id:'idle-tie-a',status:'idle',updatedAt:at(18)},
    {id:'active-created',status:'waiting',createdAt:at(17)},
    {id:'active-tie-b',status:'unknown',createdAt:at(16),updatedAt:at(20)},
    {id:'idle-created',status:'idle',createdAt:at(17)},
    {id:'idle-tie-b',status:'idle',updatedAt:at(18)},
    {id:'active-undated',status:'failed'},
    {id:'idle-undated',status:'idle'},
  ]);
  assert.deepEqual(ids(result.active),['active-created','active-tie-a','active-tie-b','active-undated','idle-tie-a']);
  assert.deepEqual(ids(result.idle),['idle-tie-b','idle-created','idle-undated']);
});

test('empty, one-idle and idle-only lists do not duplicate or hide the retained idle thread',()=>{
  assert.deepEqual(ids(groups([]).active),[]);assert.deepEqual(ids(groups([]).idle),[]);
  assert.deepEqual(ids(groups([{id:'only',status:'idle'}]).active),['only']);
  assert.deepEqual(ids(groups([{id:'only',status:'idle'}]).idle),[]);
  const result=groups([{id:'older',status:'idle',updatedAt:at(10)},{id:'latest',status:'idle',updatedAt:at(15)}]);
  assert.deepEqual(ids(result.active),['latest']);assert.deepEqual(ids(result.idle),['older']);
});
