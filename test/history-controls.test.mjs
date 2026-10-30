import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const {HISTORY_TREE_JS}=require('../out/history-controls.js');
const context=vm.createContext({});vm.runInContext(HISTORY_TREE_JS,context);
const rows=[
  {id:'root',title:'Root'},
  {id:'parent',title:'Parent',parent_id:'root',source:'fork',relation:'inherited'},
  {id:'child',title:'Child',parent_id:'parent',source:'fork',relation:'inherited'},
  {id:'manual',title:'Manual fork',parent_id:'parent',source:'rpc',relation:'inherited'},
  {id:'orphan',parent_id:'missing'},
  {id:'a',parent_id:'b'},
  {id:'b',parent_id:'a'},
  {id:'self',parent_id:'self'},
];

test('lineage keeps delegated threads nested while a manual history fork begins a conversation',()=>{
  const tree=context.historyTree(rows,'lineage');
  assert.deepEqual(Array.from(tree,e=>[e.row.id,e.depth]),[
    ['root',0],['parent',1],['child',2],['manual',0],['orphan',0],['a',0],['b',1],['self',0],
  ]);
  const entry=id=>tree.find(item=>item.row.id===id);
  assert.equal(context.historyKind(entry('manual')),'Started from Parent');
  assert.equal(context.historyKind(entry('parent')),'Subagent');
  assert.equal(context.historyKind(entry('root')),'Root conversation');
  assert.equal(context.historyKind(entry('orphan')),'Parent not in results');
  assert.equal(context.historyKind(entry('a')),'Unresolved parent cycle');
  assert.deepEqual(Array.from(context.historyTree(rows,'recent'),e=>e.row.id),rows.map(r=>r.id));
});

test('the injected tree and the session family agree on what a manual fork is',()=>{
  const {isHistoryFork}=require('../out/session-family.js');
  for(const relation of ['inherited','detached',null,undefined])for(const source of ['fork','gateway',null,undefined]){
    const row={relation,source};
    assert.equal(context.historyFork(row),isHistoryFork(row),`relation=${relation} source=${source}`);
  }
});

test('the injected tree and the session family agree on what a manual fork is',()=>{
  const {isHistoryFork}=require('../out/session-family.js');
  for(const relation of ['inherited','detached',null,undefined])for(const source of ['fork','gateway',null,undefined]){
    const row={relation,source};
    assert.equal(context.historyFork(row),isHistoryFork(row),`relation=${relation} source=${source}`);
  }
});

test('a manual fork with no title on its origin still reads as a conversation',()=>{
  const tree=context.historyTree([{id:'origin'},{id:'fork',parent_id:'origin',relation:'inherited'}],'lineage');
  assert.deepEqual(Array.from(tree,e=>[e.row.id,e.depth]),[['origin',0],['fork',0]]);
  assert.equal(context.historyKind(tree[1]),'Started from a previous chat');
});
