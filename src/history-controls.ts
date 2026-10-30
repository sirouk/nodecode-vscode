// The native directory supplies explicit parents; no inferred task lineage.
// A manual history fork is a conversation the operator continued — its origin
// stays discoverable, but it is not drawn as a child of the chat it came from.
export const HISTORY_MODES = `<div class="history-modes" role="group" aria-label="History view"><button data-history-mode="lineage" aria-pressed="true">Lineage</button><button data-history-mode="recent" aria-pressed="false">Recent</button></div>`;
export const HISTORY_CSS = `.history-modes{display:flex;gap:4px;padding:3px 6px}.history-modes button{font-size:11px;padding:3px 8px}.history-modes [aria-pressed="true"]{background:var(--surface);border:1px solid var(--border)}.session-row[data-depth]{margin-left:calc(min(var(--history-depth),8)*12px);border-left:1px solid var(--border)}.session-lineage{font-size:10px;color:var(--dim)}.session-context{opacity:.7}`;
export const HISTORY_TREE_JS = String.raw`
function historyFork(row){return row.relation==='inherited'&&row.source!=='fork';}
function historyTree(rows,mode){
  if(mode==='recent')return rows.map(function(row){return {row:row,depth:0};});
  var map=new Map(rows.map(function(row){return [row.id,row];})),children=new Map(),seen=new Set(),result=[];
  rows.forEach(function(row){
    if(historyFork(row))return;
    if(row.parent_id&&map.has(row.parent_id)&&row.parent_id!==row.id){var list=children.get(row.parent_id)||[];list.push(row);children.set(row.parent_id,list);}
  });
  function visit(row,depth,cycle){
    if(seen.has(row.id))return;seen.add(row.id);
    result.push({row:row,depth:depth,cycle:cycle,orphan:!historyFork(row)&&!!row.parent_id&&!map.has(row.parent_id),parent:row.parent_id?map.get(row.parent_id):undefined});
    (children.get(row.id)||[]).forEach(function(child){visit(child,depth+1,false);});
  }
  rows.filter(function(row){return historyFork(row)||!row.parent_id||!map.has(row.parent_id);}).forEach(function(row){visit(row,0,false);});
  rows.forEach(function(row){if(!seen.has(row.id))visit(row,0,true);});
  return result;
}
function historyKind(entry){
  var row=entry.row;
  if(entry.cycle)return 'Unresolved parent cycle';
  if(entry.orphan)return 'Parent not in results';
  if(!row.parent_id)return 'Root conversation';
  if(row.source==='fork')return 'Subagent';
  if(row.relation==='inherited'){
    var title=entry.parent&&(entry.parent.title||entry.parent.semanticTitle);
    return title?'Started from '+title:'Started from a previous chat';
  }
  return 'Child thread';
}
`;
