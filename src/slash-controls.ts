// Native command autocomplete and result dialogs; shares the composer picker.
export const SLASH_MARKUP = `<div id="commandResult" class="hidden"><div class="picker-heading"><strong id="commandTitle">Command result</strong><button id="closeCommandResult" aria-label="Close command result">×</button></div><div id="commandBody"></div></div>`;

export const SLASH_CLIENT_JS = String.raw`
  var slashCommands=[],lastSlashMessage,slashDialogTab=null;
  function updateSlashQuery(before){
    if(!before.startsWith('/'))return false;
    var match=before.match(/^\/([^\s]*)(?:\s([\s\S]*))?$/);
    if(!match)return false;
    clearTimeout(fileTimer);
    var args=match[2],name=match[1],entry=slashCommands.find(function(c){return c.name.replace(/^\//,'')===name;});
    if(args!==undefined&&entry&&!entry.autocomplete){closeFilePicker();return true;}
    fileQuery={kind:args===undefined?'slash':'slash-arg',name:name,text:args===undefined?name:args,start:0,end:composer.selectionStart};
    var requestId=++fileRequest;fileResults=[];E('filePicker').classList.remove('hidden');E('filePicker').setAttribute('aria-label','Nodecode commands');composer.setAttribute('aria-expanded','true');E('filePicker').innerHTML='<div class="picker-message">Loading commands…</div>';positionFilePicker();
    fileTimer=setTimeout(function(){vscode.postMessage(args===undefined?{type:'slashCatalog',requestId:requestId}:{type:'slashCompletions',name:name,text:args,requestId:requestId});},100);
    return true;
  }
  function applySlashItems(items){
    if(!items.length){closeFilePicker();return;}
    renderFileResults({files:items});
  }
  function runSlashLine(line){
    if(sending)return;
    if(line.trim()==='/models'||line.trim()==='/think'){if(composer.value.trim()===line.trim()){composer.value='';grow();saveDraft();}openOptions(line.trim()==='/models'?'model':'effort');return;}
    if(line.trim()==='/undo'||line.trim()==='/redo'){sending=true;closeFilePicker();renderAll(followLatest);vscode.postMessage({type:'slashCheckpoint',line:line,direction:line.trim().slice(1)});return;}
    if(line.trim()==='/clear'||line.trim()==='/new'){if(composer.value.trim()===line.trim()){composer.value='';grow();saveDraft();}vscode.postMessage({type:'newSession'});return;}
    if(line.trim()==='/sessions'){if(composer.value.trim()===line.trim()){composer.value='';grow();saveDraft();}E('sessBtn').click();return;}
    sending=true;closeFilePicker();renderAll(followLatest);vscode.postMessage({type:'runSlash',line:line});
  }
  function renderSlashResult(message,tabOnly){
    if(!tabOnly){lastSlashMessage=message;slashDialogTab=null;sending=false;}
    if(!tabOnly&&!message.error&&composer.value.trim()===message.line){composer.value='';grow();saveDraft();}
    E('commandResult').classList.remove('hidden');
    E('commandTitle').textContent=message.line||'Command result';
    var result=message.result||{},dialog=result.dialog,html='';
    if(message.error)html='<div class="sys error">'+esc(message.error)+'</div>';
    else if(result.text)html=md(result.text);
    if(dialog){
      if(dialog.title)E('commandTitle').textContent=dialog.title;
      if(dialog.context)html+='<div class="sub">'+esc(dialog.context)+'</div>';
      if(dialog.picture&&Array.isArray(dialog.picture.rows))html+='<pre>'+esc(dialog.picture.rows.join('\n'))+'</pre>';
      if(Array.isArray(dialog.tabs))html+='<div class="command-tabs">'+dialog.tabs.map(function(tab,i){return '<button data-slash-tab="'+i+'" aria-pressed="'+String((tab.value==null?null:tab.value)===slashDialogTab)+'">'+esc(tab.label)+(typeof tab.count==='number'?' ('+tab.count+')':'')+'</button>';}).join('')+'</div>';
      (dialog.rows||[]).forEach(function(row){
        if(slashDialogTab!==null&&row.key!==slashDialogTab)return;
        var line=row.run&&row.run.enter,value=row.value;
        html+='<div class="command-row"><button '+(typeof line==='string'&&line.startsWith('/')?'data-slash="'+esc(line)+'"':typeof value==='string'?'data-insert="'+esc(value)+'"':'disabled')+'>'+esc(row.label||row.key)+(row.detail?'<span class="sub">'+esc(row.detail)+'</span>':'')+'</button>';
        (row.options||[]).forEach(function(option){var command=option.run&&option.run.enter;if(typeof command==='string'&&command.startsWith('/'))html+='<button data-slash="'+esc(command)+'">'+esc(option.label)+'</button>';});html+='</div>';
      });
      if(dialog.hint)html+='<div class="sub">'+esc(dialog.hint)+'</div>';
    }
    E('commandBody').innerHTML=html||'<div class="sub">Command completed.</div>';renderMarkdownBlocks(E('commandBody'));renderAll(followLatest);
  }
  window.addEventListener('message',function(ev){var message=ev.data;if(!message)return;
    if(message.type==='slashResult'){renderSlashResult(message);return;}
    if(message.type==='slashError'&&message.requestId===fileRequest){closeFilePicker();renderSlashResult({line:composer.value,error:message.message});return;}
    if(!fileQuery||message.requestId!==fileRequest)return;
    if(message.type==='slashCatalog'){
      slashCommands=message.commands||[];
      var rows=slashCommands.filter(function(c){return c.name.toLowerCase().includes(fileQuery.text.toLowerCase());}).map(function(c){var name=c.name.replace(/^\//,'');return {kind:'slash',path:'/'+name,description:c.description,value:'/'+name+' '};});
      rows=rows.filter(function(row){return row.path!=='/clear'&&row.path!=='/new';});
      ['clear','new'].forEach(function(name){if(name.includes(fileQuery.text.toLowerCase()))rows.push({kind:'slash',path:'/'+name,description:'Start a new editor conversation',value:'/'+name+' '});});
      if('sessions'.includes(fileQuery.text.toLowerCase()))rows.push({kind:'slash',path:'/sessions',description:'Browse editor conversations',value:'/sessions '});
      applySlashItems(rows);
    }else if(message.type==='slashCompletions')applySlashItems((message.choices||[]).map(function(c){return {kind:'slash',path:c.name,value:'/'+fileQuery.name+' '+c.value+' '};}));
  });
  E('closeCommandResult').addEventListener('click',function(){E('commandResult').classList.add('hidden');});
  E('commandBody').addEventListener('click',function(ev){var tab=ev.target.closest('[data-slash-tab]');if(tab){var item=lastSlashMessage.result.dialog.tabs[Number(tab.dataset.slashTab)];slashDialogTab=item.value==null?null:item.value;renderSlashResult(lastSlashMessage,true);return;}var button=ev.target.closest('[data-slash],[data-insert]');if(button){if(button.dataset.slash)runSlashLine(button.dataset.slash);else{var start=composer.selectionStart,end=composer.selectionEnd;composer.value=composer.value.slice(0,start)+button.dataset.insert+composer.value.slice(end);composer.setSelectionRange(start+button.dataset.insert.length,start+button.dataset.insert.length);grow();saveDraft();E('commandResult').classList.add('hidden');composer.focus();}}});
`;
