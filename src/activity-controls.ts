// Compact projections of native session relationships, file receipts and processes.
export const ACTIVITY_CSS = `.activity-section{width:100%;font-size:12px}.activity-section>summary{cursor:pointer;color:var(--dim);padding:3px}.activity-body{max-height:260px;overflow:auto;padding-top:5px;padding-left:14px}.activity-link{display:flex;align-items:center;gap:7px;width:100%;text-align:left;padding:5px}.activity-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.activity-kind{margin-left:auto;color:var(--dim);font-size:10px;white-space:nowrap}.agent-dot{width:7px;height:7px;flex-shrink:0;border-radius:50%}.activity-file,.activity-process{margin:4px 0;border:1px solid var(--border);border-radius:6px;padding:5px}.activity-file summary,.activity-process summary{cursor:pointer;overflow-wrap:anywhere}.activity-file pre,.activity-process pre{max-height:170px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;overflow-anchor:none;font:11px/1.5 var(--vscode-editor-font-family,monospace);margin:6px 0}.process-controls{display:flex;align-items:center;gap:8px}.process-stop{margin-left:auto;color:var(--err)}#app #threadBar{padding:2px 12px}#threadList{max-height:min(160px,22vh);padding-top:2px;overscroll-behavior:contain}#threadList .activity-link{padding:3px 5px;gap:6px}#idleThreadList{padding-left:14px}#idleThreadDetails>summary{cursor:pointer;color:var(--dim);padding:3px 5px;font-size:11px}.sys.spawn-notice{margin:5px 0;text-align:left;border-left:3px solid var(--agent-color);border-radius:4px;background:var(--surface);max-width:100%;overflow:hidden}.spawn-notice>button{display:block;width:100%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;padding:4px 8px}#fileBar:empty{display:none}#fileBar{padding:2px 12px}`;

// Last activity is the roster's recency signal, not a historical idle transition.
export const THREAD_ORDER_JS = String.raw`
  function threadGroups(rows){
    function time(row,field){var at=Date.parse(row[field]||'');return Number.isNaN(at)?Date.parse(row.createdAt||'')||0:at;}
    var active=rows.filter(function(row){return row.status!=='idle';}).sort(function(a,b){return time(b,'startedAt')-time(a,'startedAt');});
    var idle=rows.filter(function(row){return row.status==='idle';}).sort(function(a,b){return time(b,'updatedAt')-time(a,'updatedAt');});
    if(idle.length)active.push(idle.shift());
    return {active:active,idle:idle};
  }
`;

export const ACTIVITY_CLIENT_JS = String.raw`
  ${THREAD_ORDER_JS}
  var activitySignature={threads:'',files:''};
  E('threadBar').innerHTML='<details class="activity-section" id="threadDetails"><summary id="threadSummary">Agents & threads</summary><div class="activity-body" id="threadList"><div id="activeThreadList"></div><details id="idleThreadDetails" class="hidden"><summary id="idleThreadSummary">Idle</summary><div id="idleThreadList"></div></details></div></details>';
  E('fileBar').innerHTML='<details class="activity-section" id="fileDetails"><summary id="fileSummary">Modified files</summary><div class="activity-body" id="fileList"></div></details>';
  E('procBar').innerHTML='<details class="activity-section" id="processDetails"><summary id="processSummary">Background processes</summary><div class="activity-body" id="processList"></div></details>';
  ['thread','file','process'].forEach(function(name){var details=E(name+'Details');details.open=!!expanded['section-'+name];details.addEventListener('toggle',function(){expanded['section-'+name]=details.open;saveDraft();});});
  var idleThreadDetails=E('idleThreadDetails');idleThreadDetails.open=!!expanded['section-thread-idle'];
  idleThreadDetails.addEventListener('toggle',function(){expanded['section-thread-idle']=idleThreadDetails.open;saveDraft();});
  function agentColor(id){var hash=2166136261;for(var i=0;i<id.length;i++){hash^=id.charCodeAt(i);hash=Math.imul(hash,16777619);}return 'hsl('+(Math.abs(hash)%360)+' 65% 65%)';}
  function threadRow(row){var kind=row.kind||'thread',status=row.status||'unknown',name=row.title||'Untitled '+kind,context=row.familyRole+(row.relativeDepth>1?' · depth '+row.relativeDepth:'');return '<button class="activity-link" data-a="openThread" data-p="'+esc(row.id)+'" title="'+esc(name+' · '+context+' · '+kind+' · '+status+' · '+row.id)+'"><span class="agent-dot" style="background:'+agentColor(row.id)+'"></span><span class="activity-name">'+esc(name)+'</span><span class="activity-kind">'+esc(kind)+' · '+esc(status)+'</span></button>';}
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
    var ancestors=view.ancestors||[],siblings=view.siblings||[],descendants=view.descendants||view.threads||[],threadSignature=JSON.stringify([view.parentId,ancestors,siblings,descendants]);
    function related(rows,role){return rows.map(function(row){return Object.assign({},row,{familyRole:role});});}
    var all=related(ancestors,'Parent').concat(related(siblings,'Sibling'),related(descendants,'Child'));
    if(!ancestors.length&&view.parentId)all.push({id:view.parentId,title:'Parent session',status:'unknown',kind:'thread',familyRole:'Parent'});
    E('threadBar').classList.toggle('hidden',!all.length&&!view.parentId);
    E('threadSummary').textContent='Agents & threads · '+descendants.length+(descendants.some(function(t){return t.status==='running';})?' · '+descendants.filter(function(t){return t.status==='running';}).length+' running':'');
    if(threadSignature!==activitySignature.threads&&!hasSelection(E('threadList'))){
      var groups=threadGroups(all);
      preserveActivityList(E('threadList'),function(){
        E('activeThreadList').innerHTML=groups.active.map(threadRow).join('');
        E('idleThreadList').innerHTML=groups.idle.map(threadRow).join('');
        E('idleThreadSummary').textContent='Idle · '+groups.idle.length;
        idleThreadDetails.classList.toggle('hidden',!groups.idle.length);
      });activitySignature.threads=threadSignature;
    }
    var files=view.modifiedFiles||[],fileSignature=JSON.stringify(files);
    if(!hasSelection(E('fileList'))){E('fileBar').classList.toggle('hidden',!files.length);
    var fileHeading='Modified files · '+files.length+'<span class="diff-section-counts">'+diffTotalsHtml(files)+'</span>';if(E('fileSummary').innerHTML!==fileHeading)E('fileSummary').innerHTML=fileHeading;}
    if(fileSignature!==activitySignature.files&&!hasSelection(E('fileList'))){
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
    var processes=view.processes||[],processList=E('processList');
    E('procBar').classList.toggle('hidden',!processes.length);E('processSummary').textContent='Background processes · '+processes.length;
    var keep=new Set();processes.forEach(function(process){
      keep.add(process.id);var node=Array.from(processList.children).find(function(el){return el.dataset.processId===process.id;});
      if(!node){node=document.createElement('details');node.className='activity-process';node.dataset.processId=process.id;node.open=!!expanded['process:'+process.id];node.innerHTML='<summary class="process-command"></summary><div class="process-controls"><span class="process-status sub"></span><button class="process-stop" data-a="interrupt">Stop</button></div><pre class="process-output" tabindex="0" aria-label="Background process output"></pre>';processList.appendChild(node);trackFollow(node.querySelector('pre'),4);}
      var command=node.querySelector('.process-command');if(command.textContent!==process.command&&!hasSelection(command))command.textContent=process.command||'Background process';
      node.querySelector('.process-status').textContent=[process.status,process.exitCode!==undefined?'exit '+process.exitCode:'',process.shellExit&&process.shellExit!==process.status?'shell '+process.shellExit:'',process.error||'',process.outputTruncated?'retained output tail':''].filter(Boolean).join(' · ');
      var stop=node.querySelector('.process-stop');stop.dataset.p=String(process.execId);stop.classList.toggle('hidden',view.cached||view.replayComplete===false||process.status!=='running'||!Number.isSafeInteger(process.execId));
      var pane=node.querySelector('pre'),output=process.output||process.preview||'';captureFollow(pane);if(pane.textContent!==output){if(output.startsWith(pane.textContent)&&pane.firstChild)pane.firstChild.appendData(output.slice(pane.textContent.length));else if(!hasSelection(pane))pane.textContent=output;}followPane(pane);
    });
    Array.from(processList.children).forEach(function(node){if(!keep.has(node.dataset.processId)&&!hasSelection(node))node.remove();});
  }
  E('processList').addEventListener('toggle',function(ev){if(ev.target.dataset.processId){expanded['process:'+ev.target.dataset.processId]=ev.target.open;if(ev.target.open)followPane(ev.target.querySelector('pre'));saveDraft();}},true);
`;
