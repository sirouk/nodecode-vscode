// Compact projections of native session relationships, file receipts and processes.
export const ACTIVITY_CSS = `.activity-section{width:100%;font-size:12px}.activity-section>summary{cursor:pointer;color:var(--dim);padding:3px}.activity-body{max-height:260px;overflow:auto;padding-top:5px;padding-left:14px}.activity-link{display:flex;align-items:center;gap:7px;width:100%;text-align:left;padding:5px}.activity-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.activity-kind{margin-left:auto;color:var(--dim);font-size:10px;white-space:nowrap}.agent-dot{width:7px;height:7px;flex-shrink:0;border-radius:50%}.activity-file,.activity-process{margin:4px 0;border:1px solid var(--border);border-radius:6px;padding:5px}.activity-file summary,.activity-process summary{cursor:pointer;overflow-wrap:anywhere}.activity-file pre,.activity-process pre{max-height:170px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;overflow-anchor:none;font:11px/1.5 var(--vscode-editor-font-family,monospace);margin:6px 0}.process-controls{display:flex;align-items:center;gap:8px}.process-stop{margin-left:auto;color:var(--err)}#app #threadBar{padding:2px 12px}#threadList{max-height:min(160px,22vh);padding-top:2px;overscroll-behavior:contain}#threadList .activity-link{padding:3px 5px 3px calc(5px + var(--thread-depth,0)*14px);gap:6px}#threadList [aria-current="true"]{background:var(--vscode-list-activeSelectionBackground,#fa8b3e24);color:var(--vscode-list-activeSelectionForeground,var(--fg));border-color:var(--vscode-focusBorder,var(--accent))}#idleThreadList{padding-left:14px}#idleThreadDetails>summary{cursor:pointer;color:var(--dim);padding:3px 5px;font-size:11px}.sys.spawn-notice{margin:5px 0;text-align:left;border-left:3px solid var(--agent-color);border-radius:4px;background:var(--surface);max-width:100%;overflow:hidden}.spawn-notice>button{display:block;width:100%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;padding:4px 8px}#fileBar:empty{display:none}#fileBar{padding:2px 12px}`;

// Last activity is the roster's recency signal, not a historical idle transition.
export const THREAD_ORDER_JS = String.raw`
  function threadGroups(rows){
    function time(row,field){var at=Date.parse(row[field]||'');return Number.isNaN(at)?Date.parse(row.createdAt||'')||0:at;}
    var active=rows.filter(function(row){return row.status!=='idle';}).sort(function(a,b){return time(b,'startedAt')-time(a,'startedAt');});
    var idle=rows.filter(function(row){return row.status==='idle';}).sort(function(a,b){return time(b,'updatedAt')-time(a,'updatedAt');});
    if(idle.length)active.push(idle.shift());
    return {active:active,idle:idle};
  }
  function threadFamilyGroups(rows){
    var levels=new Map(),active=[],idle=[];
    rows.forEach(function(row){var parent=row.parentId||null,level=levels.get(parent)||[];level.push(row);levels.set(parent,level);});
    levels.forEach(function(level){var group=threadGroups(level);active=active.concat(group.active);idle=idle.concat(group.idle);});
    return {active:active,idle:idle};
  }
  // A manual history fork is its own conversation: it keeps one link back to
  // where it began, hides siblings, and never appears as a child of its origin.
  function threadPresentation(view){
    var current=view.currentThread,ancestors=view.ancestors||[],siblings=view.siblings||[],descendants=view.descendants||view.threads||[];
    var historyFork=!!(current&&current.kind==='history-fork');
    var parents;
    if(historyFork){
      parents=ancestors.length?[Object.assign({},ancestors[ancestors.length-1],{familyRole:'Started from',indent:0})]
        :(view.parentId?[{id:view.parentId,title:'Previous chat',status:'unknown',kind:'thread',familyRole:'Started from',indent:0}]:[]);
    } else {
      parents=ancestors.map(function(row,index){return Object.assign({},row,{familyRole:'Parent',indent:index});});
      if(!parents.length&&view.parentId)parents.push({id:view.parentId,title:'Parent session',status:'unknown',kind:'thread',familyRole:'Parent',indent:0});
    }
    var byId=new Map(descendants.map(function(row){return [row.id,row];}));
    var hidden=new Set(descendants.filter(function(row){return row.kind==='history-fork';}).map(function(row){return row.id;}));
    // Walk up to a hidden ancestor; a missing row ends the walk and so does a
    // parent cycle, which history rows can hold even though it has no root.
    function underHidden(row){var parent=row.parentId,seen=new Set();while(parent&&!seen.has(parent)){if(hidden.has(parent))return true;seen.add(parent);var up=byId.get(parent);parent=up&&up.parentId;}return false;}
    return {historyFork:historyFork,parents:parents,siblings:historyFork?[]:siblings,descendants:hidden.size?descendants.filter(function(row){return !hidden.has(row.id)&&!underHidden(row);}):descendants};
  }
`;

export const ACTIVITY_CLIENT_JS = String.raw`
  ${THREAD_ORDER_JS}
  var activitySignature={threads:'',files:''},threadSelectionRevealed=false,activityFiles,emptyActivityFiles=[];
  E('threadBar').innerHTML='<details class="activity-section" id="threadDetails"><summary id="threadSummary">Agents & threads</summary><div class="activity-body" id="threadList"><div id="parentThreadList"></div><div id="activeThreadList"></div><details id="idleThreadDetails" class="hidden"><summary id="idleThreadSummary">Idle</summary><div id="idleThreadList"></div></details></div></details>';
  E('fileBar').innerHTML='<details class="activity-section" id="fileDetails"><summary id="fileSummary">Modified files</summary><div class="activity-body" id="fileList"></div></details>';
  E('procBar').innerHTML='<details class="activity-section" id="processDetails"><summary id="processSummary">Background processes</summary><div class="activity-body" id="processList"></div></details>';
  ['file','process'].forEach(function(name){var details=E(name+'Details');details.open=!!expanded['section-'+name];details.addEventListener('toggle',function(){expanded['section-'+name]=details.open;saveDraft();});});
  var idleThreadDetails=E('idleThreadDetails');
  function saveThreadNavigation(){
    var navigation={open:E('threadDetails').open,idleOpen:idleThreadDetails.open};
    expanded['section-thread']=navigation.open;expanded['section-thread-idle']=navigation.idleOpen;
    persisted.threadNavigation=navigation;saveDraft();return navigation;
  }
  function restoreThreadNavigation(navigation){
    if(!navigation)return;
    threadSelectionRevealed=false;
    E('threadDetails').open=!!navigation.open;idleThreadDetails.open=!!navigation.idleOpen;saveThreadNavigation();revealSelectedThread();
  }
  // Reveal on navigation or first opening, not on subsequent live updates or user scrolling.
  function revealSelectedThread(){
    var box=E('threadList'),selected=box.querySelector('[aria-current="true"]');
    if(threadSelectionRevealed||!E('threadDetails').open||!selected)return;
    var bounds=box.getBoundingClientRect(),row=selected.getBoundingClientRect();
    if(row.bottom>bounds.bottom)box.scrollTop+=row.bottom-bounds.bottom;
    else if(row.top<bounds.top)box.scrollTop+=row.top-bounds.top;
    threadSelectionRevealed=true;
  }
  E('threadDetails').open=!!expanded['section-thread'];idleThreadDetails.open=!!expanded['section-thread-idle'];
  restoreThreadNavigation(persisted.threadNavigation);
  E('threadDetails').addEventListener('toggle',function(){saveThreadNavigation();revealSelectedThread();});
  idleThreadDetails.addEventListener('toggle',saveThreadNavigation);
  function agentColor(id){var hash=2166136261;for(var i=0;i<id.length;i++){hash^=id.charCodeAt(i);hash=Math.imul(hash,16777619);}return 'hsl('+(Math.abs(hash)%360)+' 65% 65%)';}
  function threadRow(row){
    var kind=row.kind||'thread',status=row.status||'unknown',name=row.title||'Untitled '+kind,current=row.id===sessionId,context=current?'Current thread':row.familyRole;
    return '<button class="activity-link" data-a="openThread" data-p="'+esc(row.id)+'"'+(current?' aria-current="true"':'')+' style="--thread-depth:'+Math.min(row.indent,4)+'" title="'+esc(name+' · '+context+' · '+kind+' · '+status+' · '+row.id)+'"><span class="agent-dot" style="background:'+agentColor(row.id)+'"></span><span class="activity-name">'+esc(name)+'</span><span class="activity-kind">'+esc(current?'current':row.familyRole==='Parent'?'parent':row.familyRole==='Started from'?'previous chat':kind)+' · '+esc(status)+'</span></button>';
  }
  // Sort within each level, keeping native parent/child edges together.
  function threadHierarchy(rows){
    var byId=new Map(rows.map(function(row){return [row.id,row];})),children=new Map(),seen=new Set(),ordered=[];
    rows.forEach(function(row){var parent=byId.has(row.parentId)?row.parentId:null,group=children.get(parent)||[];group.push(row);children.set(parent,group);});
    function visit(row){if(seen.has(row.id))return;seen.add(row.id);ordered.push(row);(children.get(row.id)||[]).forEach(visit);}
    (children.get(null)||[]).forEach(visit);rows.forEach(visit);return ordered;
  }
  function preserveActivityList(box,update){
    var candidates=Array.from(box.querySelectorAll('[data-p],[data-file-path]')),anchor=candidates.find(function(el){return el.getBoundingClientRect().bottom>box.getBoundingClientRect().top;}),key=anchor&&(anchor.dataset.p||anchor.dataset.filePath),offset=anchor&&anchor.getBoundingClientRect().top-box.getBoundingClientRect().top,top=box.scrollTop;
    var diffFocus=rememberDiffFocus(box);
    box.querySelectorAll('[data-diff-key]').forEach(function(details){expanded[details.dataset.diffKey]=details.open;});
    var active=document.activeElement,entry=box.contains(active)&&active.closest('[data-p],[data-file-path]'),focusKey=entry&&(entry.dataset.p||entry.dataset.filePath),focusSummary=active.tagName==='SUMMARY',idleSummaryFocused=box===E('threadList')&&active===E('idleThreadSummary');
    var positions=Array.from(box.querySelectorAll('[data-file-path]')).map(function(file){return {path:file.dataset.filePath,panes:Array.from(file.querySelectorAll('pre')).map(function(pre){return [pre.scrollTop,pre.scrollLeft];})};});
    update();
    var replacement=key&&Array.from(box.querySelectorAll('[data-p],[data-file-path]')).find(function(el){return(el.dataset.p||el.dataset.filePath)===key;});
    box.scrollTop=replacement?box.scrollTop+replacement.getBoundingClientRect().top-box.getBoundingClientRect().top-offset:top;
    var focus=focusKey&&Array.from(box.querySelectorAll('[data-p],[data-file-path]')).find(function(el){return(el.dataset.p||el.dataset.filePath)===focusKey;});
    if(focus&&focus.closest('#idleThreadList')&&!idleThreadDetails.open)focus=E('idleThreadSummary');
    if(idleSummaryFocused&&idleThreadDetails.classList.contains('hidden'))focus=E('threadSummary');
    if(focus&&!diffFocus){if(focusSummary)focus=focus.querySelector('summary')||focus;focus.focus({preventScroll:true});}
    restoreDiffFocus(box,diffFocus);
    positions.forEach(function(saved){var file=Array.from(box.querySelectorAll('[data-file-path]')).find(function(el){return el.dataset.filePath===saved.path;});if(file)file.querySelectorAll('pre').forEach(function(pre,i){if(saved.panes[i]){pre.scrollTop=saved.panes[i][0];pre.scrollLeft=saved.panes[i][1];}});});
  }
  function renderActivity(view){
    var ancestors=view.ancestors||[],current=view.currentThread,presentation=threadPresentation(view);
    var siblings=presentation.siblings,descendants=presentation.descendants,parents=presentation.parents;
    var baseDepth=presentation.historyFork?0:ancestors.length;
    var threadSignature=JSON.stringify([view.sessionId,view.parentId,current,parents,siblings,descendants]);
    function related(rows,role){return rows.map(function(row){return Object.assign({},row,{familyRole:role,indent:Math.max(0,baseDepth+(row.relativeDepth||0))});});}
    var hasFamily=parents.length||siblings.length||descendants.length;
    var parentIds=new Set(parents.map(function(row){return row.id;}));
    var all=related(siblings,'Sibling').concat(current&&hasFamily?related([current],'Current'):[],related(descendants,'Child')).filter(function(row){return !parentIds.has(row.id);});
    if(!presentation.historyFork&&!ancestors.length&&parents.length)all.forEach(function(row){row.indent++;});
    E('threadBar').classList.toggle('hidden',!hasFamily);
    var threadHeading='Agents & threads · '+descendants.length+(descendants.some(function(t){return t.status==='running';})?' · '+descendants.filter(function(t){return t.status==='running';}).length+' running':'');
    if(E('threadSummary').textContent!==threadHeading)E('threadSummary').textContent=threadHeading;
    if(threadSignature!==activitySignature.threads&&!hasSelection(E('threadList'))){
      var groups=threadFamilyGroups(all.filter(function(row){return row.id!==sessionId;}));
      var selected=all.find(function(row){return row.id===sessionId;});if(selected)groups.active.unshift(selected);
      // Never hide an ancestor of visible work inside the idle fold.
      var byId=new Map(all.map(function(row){return [row.id,row];})),visible=new Set(groups.active.map(function(row){return row.id;}));
      groups.active.forEach(function(row){var parent=byId.get(row.parentId);while(parent&&!visible.has(parent.id)){visible.add(parent.id);parent=byId.get(parent.parentId);}});
      groups.active=threadHierarchy(groups.active.concat(groups.idle.filter(function(row){return visible.has(row.id);})));groups.idle=threadHierarchy(groups.idle.filter(function(row){return !visible.has(row.id);}));
      preserveActivityList(E('threadList'),function(){
        E('parentThreadList').innerHTML=parents.map(threadRow).join('');
        E('activeThreadList').innerHTML=groups.active.map(threadRow).join('');
        E('idleThreadList').innerHTML=groups.idle.map(threadRow).join('');
        E('idleThreadSummary').textContent='Idle · '+groups.idle.length;
        idleThreadDetails.classList.toggle('hidden',!groups.idle.length);
      });activitySignature.threads=threadSignature;revealSelectedThread();
    }
    var files=view.modifiedFiles||emptyActivityFiles;
    // Omitted collections retain their identity; only mark one applied after selection permits it.
    if(files!==activityFiles&&!hasSelection(E('fileList'))){
      var fileSignature=JSON.stringify(files);
      E('fileBar').classList.toggle('hidden',!files.length);
      var fileHeading='Modified files · '+files.length+'<span class="diff-section-counts">'+diffTotalsHtml(files)+'</span>';if(E('fileSummary').innerHTML!==fileHeading)E('fileSummary').innerHTML=fileHeading;
      if(fileSignature!==activitySignature.files){
        preserveActivityList(E('fileList'),function(){
          var list=E('fileList'),existing=new Map(Array.from(list.querySelectorAll(':scope > [data-file-path]')).map(function(node){return [node.dataset.filePath,node];})),keep=new Set();
          files.forEach(function(file,index){
            keep.add(file.path);var html=diffFileHtml(file,'file:'+file.path,'activity-file','Latest recorded change'+(file.changeCount?' · '+file.changeCount+' change receipt'+(file.changeCount===1?'':'s'):'')),node=existing.get(file.path);
            if(!node||node._html!==html){var box=document.createElement('div');box.innerHTML=html;var next=box.firstElementChild;next._html=html;if(node)node.replaceWith(next);node=next;}
            if(list.children[index]!==node)list.insertBefore(node,list.children[index]||null);
          });
          existing.forEach(function(node,path){if(!keep.has(path))node.remove();});
          var note=list.querySelector('.diff-provenance');if(!note){note=document.createElement('div');note.className='diff-provenance';note.textContent='Latest recorded change per file · not a net session diff';list.appendChild(note);}
          restoreDiffState(list);
        });activitySignature.files=fileSignature;
      }
      activityFiles=files;
    }
    var processes=view.processes||[],processList=E('processList'),processHeading='Background processes · '+processes.length;
    if(E('procBar').classList.contains('hidden')!==!processes.length)E('procBar').classList.toggle('hidden',!processes.length);
    if(E('processSummary').textContent!==processHeading)E('processSummary').textContent=processHeading;
    var existing=new Map(Array.from(processList.children).map(function(node){return [node.dataset.processId,node];})),keep=new Set();
    processes.forEach(function(process){
      keep.add(process.id);var node=existing.get(process.id);
      if(!node){node=document.createElement('details');node.className='activity-process';node.dataset.processId=process.id;node.open=!!expanded['process:'+process.id];node.innerHTML='<summary class="process-command"></summary><div class="process-controls"><span class="process-status sub"></span><button class="process-stop" data-a="interrupt">Stop</button></div><pre class="process-output" tabindex="0" aria-label="Background process output"></pre>';processList.appendChild(node);trackFollow(node.querySelector('pre'),4);}
      var command=node.querySelector('.process-command'),commandText=process.command||'Background process';if(command.textContent!==commandText&&!hasSelection(command))command.textContent=commandText;
      var status=node.querySelector('.process-status'),statusText=[process.status,process.exitCode!==undefined?'exit '+process.exitCode:'',process.shellExit&&process.shellExit!==process.status?'shell '+process.shellExit:'',process.error||'',process.outputTruncated?'retained output tail':''].filter(Boolean).join(' · ');
      if(status.textContent!==statusText)status.textContent=statusText;
      var stop=node.querySelector('.process-stop'),execId=String(process.execId),stopHidden=!!(view.cached||view.replayComplete===false||process.status!=='running'||!Number.isSafeInteger(process.execId));
      if(stop.dataset.p!==execId)stop.dataset.p=execId;if(stop.classList.contains('hidden')!==stopHidden)stop.classList.toggle('hidden',stopHidden);
      // Unchanged history must not force layout on every streamed token.
      var pane=node.querySelector('pre'),output=process.output||process.preview||'',priorOutput=pane.textContent;
      if(priorOutput!==output){captureFollow(pane);if(output.startsWith(priorOutput)&&pane.firstChild)pane.firstChild.appendData(output.slice(priorOutput.length));else if(!hasSelection(pane))pane.textContent=output;followPane(pane);}
    });
    existing.forEach(function(node,id){if(!keep.has(id)&&!hasSelection(node))node.remove();});
  }
  E('processList').addEventListener('toggle',function(ev){if(ev.target.dataset.processId){expanded['process:'+ev.target.dataset.processId]=ev.target.open;if(ev.target.open)followPane(ev.target.querySelector('pre'));saveDraft();}},true);
  if(typeof ResizeObserver!=='undefined')new ResizeObserver(function(){E('processList').querySelectorAll('.process-output').forEach(function(pane){followPane(pane);});}).observe(E('processList'));
`;
