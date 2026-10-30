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

test('each native parent retains its own newest idle thread instead of sharing a global idle slot',()=>{
  vm.runInContext(THREAD_ORDER_JS,context);
  assert.equal(typeof context.threadFamilyGroups,'function','the webview must group each parent independently');
  const rows=[
    {id:'new-sibling',parentId:'root',status:'idle',updatedAt:at(19)},
    {id:'old-sibling',parentId:'root',status:'idle',updatedAt:at(18)},
    {id:'child-running',parentId:'current',status:'running',startedAt:at(17)},
    {id:'new-child',parentId:'current',status:'idle',updatedAt:at(12)},
    {id:'old-child',parentId:'current',status:'idle',updatedAt:at(11)},
    {id:'nested-new',parentId:'new-child',status:'idle',updatedAt:at(10)},
    {id:'nested-old',parentId:'new-child',status:'idle',updatedAt:at(9)},
    {id:'other-only',parentId:'other-parent',status:'idle',updatedAt:at(8)},
  ];
  const before=structuredClone(rows),result=context.threadFamilyGroups(rows);
  assert.deepEqual(ids(result.active),['new-sibling','child-running','new-child','nested-new','other-only']);
  assert.deepEqual(ids(result.idle),['old-sibling','old-child','nested-old']);
  assert.deepEqual(rows,before,'grouping must not mutate the authoritative family projection');
  assert.equal(new Set(ids(result.active).concat(ids(result.idle))).size,rows.length,'each thread appears once');
});

test('a history fork is its own conversation: one origin link, no siblings, no nested forks',()=>{
  vm.runInContext(THREAD_ORDER_JS,context);
  assert.equal(typeof context.threadPresentation,'function');
  const current={id:'current',title:'Current',kind:'thread',parentId:null,relativeDepth:0};
  const view={
    sessionId:'current',parentId:null,currentThread:current,ancestors:[],siblings:[],
    descendants:[
      {id:'agent',title:'Agent',kind:'subagent',parentId:'current',relativeDepth:1},
      {id:'fork',title:'New chat',kind:'history-fork',parentId:'current',relativeDepth:1},
      {id:'fork-agent',title:'Fork agent',kind:'subagent',parentId:'fork',relativeDepth:2},
    ],
  };
  const before=structuredClone(view),shown=context.threadPresentation(view);
  assert.deepEqual(ids(shown.descendants),['agent'],'a manual fork and everything under it leave the origin thread');
  assert.equal(shown.parents.length,0);assert.equal(shown.siblings.length,0);assert.equal(shown.historyFork,false);
  assert.deepEqual(view,before,'projection must not mutate the authoritative family');

  const previous={id:'parent',title:'Parent',kind:'thread',parentId:'root',relativeDepth:-1};
  const forkView={sessionId:'fork',parentId:'parent',currentThread:{id:'fork',title:'New chat',kind:'history-fork',parentId:'parent',relativeDepth:0},
    ancestors:[{id:'root',title:'Root',kind:'thread',relativeDepth:-2},previous],siblings:[{id:'sibling',title:'Other fork',kind:'history-fork',parentId:'parent',relativeDepth:0}],
    descendants:[{id:'agent',title:'Agent',kind:'subagent',parentId:'fork',relativeDepth:1},{id:'nested',title:'Nested chat',kind:'history-fork',parentId:'fork',relativeDepth:1},{id:'nested-agent',title:'Nested agent',kind:'subagent',parentId:'nested',relativeDepth:2}]};
  const forkShown=context.threadPresentation(forkView);
  assert.equal(forkShown.historyFork,true);
  assert.deepEqual(Array.from(forkShown.parents,row=>[row.id,row.familyRole]),[['parent','Started from']]);
  assert.equal(forkShown.siblings.length,0,'other conversations from the same origin are not siblings in this chat');
  assert.deepEqual(ids(forkShown.descendants),['agent']);
});

test('parent-scoped grouping preserves missing-parent and single-level ordering contracts',()=>{
  vm.runInContext(THREAD_ORDER_JS,context);
  assert.equal(typeof context.threadFamilyGroups,'function');
  const rows=[{id:'older',status:'idle',updatedAt:at(10)},{id:'running',status:'running',startedAt:at(12)},{id:'latest',status:'idle',updatedAt:at(15)}];
  assert.deepEqual(ids(context.threadFamilyGroups(rows).active),ids(groups(rows).active));
  assert.deepEqual(ids(context.threadFamilyGroups(rows).idle),ids(groups(rows).idle));
  assert.deepEqual(ids(context.threadFamilyGroups([]).active),[]);
  assert.deepEqual(ids(context.threadFamilyGroups([]).idle),[]);
});
