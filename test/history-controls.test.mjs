import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const {HISTORY_TREE_JS}=require('../out/history-controls.js');
const context=vm.createContext({});vm.runInContext(HISTORY_TREE_JS,context);
test('lineage uses explicit parents, preserves every row once and distinguishes subagents from forks',()=>{
 const rows=[{id:'child',parent_id:'root',relation:'inherited'},{id:'root'},{id:'agent',parent_id:'child',source:'fork'},{id:'orphan',parent_id:'missing'},{id:'a',parent_id:'b'},{id:'b',parent_id:'a'},{id:'self',parent_id:'self'}];
 const tree=context.historyTree(rows,'lineage');
 assert.deepEqual(Array.from(tree,e=>[e.row.id,e.depth]),[['root',0],['child',1],['agent',2],['orphan',0],['a',0],['b',1],['self',0]]);
 assert.equal(context.historyKind(tree[1]),'History fork');assert.equal(context.historyKind(tree[2]),'Subagent');assert.equal(context.historyKind(tree[3]),'Parent not in results');assert.equal(context.historyKind(tree[4]),'Unresolved parent cycle');
 assert.deepEqual(Array.from(context.historyTree(rows,'recent'),e=>e.row.id),rows.map(r=>r.id));
});
