// The native directory supplies explicit parents; no inferred task lineage.
export const HISTORY_MODES = `<div class="history-modes" role="group" aria-label="History view"><button data-history-mode="lineage" aria-pressed="true">Lineage</button><button data-history-mode="recent" aria-pressed="false">Recent</button></div>`;
export const HISTORY_CSS = `.history-modes{display:flex;gap:4px;padding:3px 6px}.history-modes button{font-size:11px;padding:3px 8px}.history-modes [aria-pressed="true"]{background:var(--surface);border:1px solid var(--border)}.session-row[data-depth]{margin-left:calc(min(var(--history-depth),8)*12px);border-left:1px solid var(--border)}.session-lineage{font-size:10px;color:var(--dim)}.session-context{opacity:.7}`;
export const HISTORY_TREE_JS = String.raw`
function historyTree(rows,mode){
  if(mode==='recent')return rows.map(function(row){return {row:row,depth:0};});
  var map=new Map(rows.map(function(row){return [row.id,row];})),children=new Map(),seen=new Set(),result=[];
  rows.forEach(function(row){if(row.parent_id&&map.has(row.parent_id)&&row.parent_id!==row.id){var list=children.get(row.parent_id)||[];list.push(row);children.set(row.parent_id,list);}});
  function visit(row,depth,cycle){if(seen.has(row.id))return;seen.add(row.id);result.push({row:row,depth:depth,cycle:cycle,orphan:!!row.parent_id&&!map.has(row.parent_id)});(children.get(row.id)||[]).forEach(function(child){visit(child,depth+1,false);});}
  rows.filter(function(row){return !row.parent_id||!map.has(row.parent_id);}).forEach(function(row){visit(row,0,false);});
  rows.forEach(function(row){if(!seen.has(row.id))visit(row,0,true);});
  return result;
}
function historyKind(entry){var row=entry.row;return entry.cycle?'Unresolved parent cycle':entry.orphan?'Parent not in results':!row.parent_id?'Root conversation':row.source==='fork'?'Subagent':row.relation==='inherited'?'History fork':'Child thread';}
`;
