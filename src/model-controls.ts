// Inline model selection shares the native session target with its reasoning menu.
export const MODEL_CLIENT_JS = String.raw`
  var modelRole='main',modelAux=null,modelDecider=null,modelBackups=null,backupAdding=false,backupResults=null;
  function receiveRoleOptions(message){modelAux=message.auxiliary||null;modelDecider=message.decider||null;modelBackups=message.failover||null;}
  function setOptionBusy(busy){optionApplying=busy;E('optionChoices').querySelectorAll('button,input').forEach(function(b){b.disabled=busy;});E('modelRoleTabs').querySelectorAll('button').forEach(function(b){b.disabled=busy;});E('modelSearch').disabled=busy;}
  function roleAction(type,body,label){if(optionApplying)return;setOptionBusy(true);E('optionStatus').textContent=label||'Saving…';vscode.postMessage(Object.assign({type:type,requestId:optionRequest},body));}
  function roleNote(){return modelRole==='main'?'Changes apply to the next turn and set the default for new sessions.':modelRole==='aux'?'Shared model for naming, recaps and summaries. Default uses each session’s own model.':modelRole==='decider'?'Answers judgments as probabilities; separate from the chat model.':'Shared ordered fallback chain. Test makes an explicit request to each backup model.';}
  function updateRoleTabs(){E('modelRoleTabs').classList.toggle('hidden',optionKind!=='model');E('modelRoleTabs').querySelectorAll('button').forEach(function(b){b.setAttribute('aria-selected',String(b.dataset.modelRole===modelRole));});E('modelSearch').classList.toggle('hidden',optionKind!=='model'||modelRole==='backup'&&!backupAdding);E('optionNote').textContent=optionKind==='effort'?'Changes apply to the next turn and set the default for new sessions.':roleNote();}
  function renderRoleOptions(choices){
    if(modelRole==='decider'){
      if(!modelDecider){choices.innerHTML='<div class="picker-message">Decider configuration unavailable.</div>';return true;}
      var q=E('modelSearch').value.trim().toLowerCase(),rows=(modelDecider.deciders||[]).filter(function(row){return [row.id,row.name,row.model,row.base_url].join(' ').toLowerCase().includes(q);});
      choices.innerHTML='<button class="option-select decider-choice" data-decider="" aria-current="'+String(!modelDecider.provider)+'"><span>None</span><span class="sub">No decider</span></button>'+rows.map(function(row){return '<button class="option-select decider-choice" data-decider="'+esc(row.id)+'" aria-current="'+String(row.id===modelDecider.provider)+'"><span>'+esc(row.name||row.id)+'</span><span class="sub">'+esc(row.model)+' · '+(row.local?'Local · ':'')+esc(row.base_url)+'</span></button>';}).join('');return true;
    }
    if(modelRole==='backup'&&!backupAdding){
      if(!modelBackups){choices.innerHTML='<div class="picker-message">Backup configuration unavailable.</div>';return true;}
      var chain=modelBackups.chain||[];
      choices.innerHTML='<div class="option-group">Tried in order</div>'+chain.map(function(row,i){return '<div class="backup-row"><span>'+String(i+1)+'. '+esc(row.model)+'<span class="sub">'+esc(row.provider)+' · '+(row.answered_at?'Last answered '+esc(row.answered_at):'Never answered')+' · rescued '+Number(row.rescued||0)+'/'+Number(row.tried||0)+'</span></span><button data-backup-up="'+i+'" aria-label="Move '+esc(row.model)+' up" '+(i===0?'disabled':'')+'>↑</button><button data-backup-down="'+i+'" aria-label="Move '+esc(row.model)+' down" '+(i===chain.length-1?'disabled':'')+'>↓</button><button data-backup-remove="'+i+'" aria-label="Remove '+esc(row.model)+'">×</button></div>';}).join('')+'<div class="role-efforts"><button id="addBackup">Add backup…</button><button id="testBackups" '+(!chain.length?'disabled':'')+'>Test backups</button></div><div class="option-group">Switch when the model hits</div>'+(modelBackups.triggers||[]).map(function(trigger){return '<label class="backup-trigger"><input type="checkbox" data-backup-trigger="'+esc(trigger.id)+'" '+(trigger.on?'checked':'')+'>'+esc(trigger.label)+'</label>';}).join('')+(backupResults?'<div class="option-group">Last test</div>'+backupResults.map(function(row){return '<div class="backup-row"><span>'+esc(row.provider+'/'+row.model)+'<span class="sub">'+(row.ok?'Passed':esc(row.reason||'Failed'))+' · '+Number(row.seconds).toFixed(2)+' s</span></span></div>';}).join(''):'');return true;
    }
    return false;
  }

  function closeOptions(focus){var kind=optionKind;setOptionBusy(false);optionKind=null;optionRequest++;E('optionPicker').classList.add('hidden');if(focus)E(kind==='effort'?'effortBtn':'modelBtn').focus();}
  function positionOptions(){
    if(!optionKind)return;
    var anchor=E(optionKind==='effort'?'effortBtn':'modelBtn').getBoundingClientRect(),menu=E('optionPicker'),width=Math.min(340,innerWidth-16);
    menu.style.width=width+'px';menu.style.left=Math.max(8,Math.min(anchor.left,innerWidth-width-8))+'px';
    var height=Math.min(menu.scrollHeight,innerHeight-16);menu.style.top=Math.max(8,anchor.top-height-5)+'px';
  }
  function renderOptions(){
    var choices=E('optionChoices'),focused=document.activeElement,starFocus=focused&&focused.dataset?{provider:focused.dataset.starProvider,model:focused.dataset.starModel}:{};
    updateRoleTabs();
    var contextLabel=typeof modelContext.limit==='number'?'Last reported context: '+(typeof modelContext.used==='number'?new Intl.NumberFormat().format(modelContext.used)+' / ':'')+new Intl.NumberFormat().format(modelContext.limit)+' tokens':'';
    E('optionStatus').textContent=optionKind==='effort'||modelRole==='main'?contextLabel:'';
    if(contextLabel)E('modelBtn').title=contextLabel+' · Choose model';
    if(optionKind==='model'&&renderRoleOptions(choices)){positionOptions();return;}
    if(optionKind==='effort'){
      var efforts=Array.isArray(modelTarget.efforts)?modelTarget.efforts:[];
      choices.innerHTML=efforts.length?efforts.map(function(level){return '<button class="option-select" data-effort="'+esc(level)+'" aria-current="'+String(level===modelTarget.effort)+'">'+esc(level)+'</button>';}).join(''):'<div class="picker-message">No reasoning options reported for this model.</div>';
    }else{
      var query=E('modelSearch').value.trim().toLowerCase();
      var rows=modelRows.filter(function(row){return [row.provider,row.model,row.name,row.display_name].filter(Boolean).join(' ').toLowerCase().includes(query);}).map(function(row){return {row:row,starred:modelFavorites.some(function(f){return f.provider===row.provider&&f.model===row.model;})};});
      rows.sort(function(a,b){return Number(b.starred)-Number(a.starred);});
      var section='';choices.innerHTML=rows.map(function(item){var row=item.row,group=item.starred?'Favorites':'All models',heading=group!==section?'<div class="option-group">'+group+'</div>':'';section=group;
        var selected=modelRole==='aux'?(modelAux||{}):modelRole==='backup'?{}:modelTarget;
        var identity=[row.provider,row.model].filter(Boolean).join('/'),context=typeof row.context==='number'?new Intl.NumberFormat().format(row.context)+' context tokens':'Context not reported';
        return heading+'<div class="option-row"><button class="option-select" data-provider="'+esc(row.provider)+'" data-model="'+esc(row.model)+'" aria-current="'+String(row.provider===selected.provider&&row.model===selected.model)+'" title="'+esc(identity)+'"><span>'+esc(row.name||row.display_name||row.model)+'</span><span class="sub">'+esc(row.provider)+' · '+esc(context)+'</span></button><button class="option-star" data-star-provider="'+esc(row.provider)+'" data-star-model="'+esc(row.model)+'" aria-pressed="'+String(item.starred)+'" aria-label="'+(item.starred?'Unstar ':'Star ')+esc(identity)+'">'+(item.starred?'★':'☆')+'</button></div>';
      }).join('')||'<div class="picker-message">No matching models.</div>';
      if(modelRole==='aux'){
        var aux=modelAux||{},efforts=Array.isArray(aux.efforts)?aux.efforts:[];
        choices.innerHTML='<button class="role-default" data-aux-default aria-current="'+String(!aux.provider)+'">Use each session’s model</button>'+(aux.provider?'<div class="option-group">Current: '+esc(aux.provider+'/'+aux.model)+'</div>':'')+(efforts.length?'<div class="role-efforts"><button data-aux-effort="" aria-pressed="'+String(!aux.effort)+'">Lightest</button>'+efforts.map(function(level){return '<button data-aux-effort="'+esc(level)+'" aria-pressed="'+String(aux.effort===level)+'">'+esc(level)+'</button>';}).join('')+'</div>':'')+choices.innerHTML;
      }else if(modelRole==='backup')choices.innerHTML='<button id="cancelBackupAdd">← Back to backups</button>'+choices.innerHTML;
    }
    if(starFocus.model){var replacement=Array.from(choices.querySelectorAll('[data-star-model]')).find(function(button){return button.dataset.starModel===starFocus.model&&button.dataset.starProvider===starFocus.provider;});if(replacement)replacement.focus({preventScroll:true});}
    positionOptions();
  }
  function openOptions(kind){
    if(optionApplying)return;
    if(optionKind===kind){closeOptions(true);return;}
    closeFilePicker();optionKind=kind;modelRole='main';backupAdding=false;backupResults=null;optionRequest++;setOptionBusy(false);updateRoleTabs();E('optionPicker').classList.remove('hidden');E('optionHeading').textContent=kind==='effort'?'Reasoning level':'Choose model';E('modelSearch').classList.toggle('hidden',kind!=='model');E('modelSearch').value='';E('optionStatus').textContent='Loading…';E('optionChoices').innerHTML='';positionOptions();vscode.postMessage({type:'modelOptions',requestId:optionRequest});if(kind==='model')E('modelSearch').focus();else E('optionClose').focus();
  }
  E('modelBtn').addEventListener('click',function(){openOptions('model');});E('effortBtn').addEventListener('click',function(){openOptions('effort');});
  E('optionClose').addEventListener('click',function(){closeOptions(true);});E('modelSearch').addEventListener('input',renderOptions);
  E('optionPicker').addEventListener('click',function(ev){ev.stopPropagation();var star=ev.target.closest('[data-star-model]'),model=ev.target.closest('[data-model]'),effort=ev.target.closest('[data-effort]');
    if(optionApplying)return;
    var role=ev.target.closest('[data-model-role]');
    if(role){modelRole=role.dataset.modelRole;backupAdding=false;E('modelSearch').value='';renderOptions();return;}
    var choice=ev.target.closest('[data-decider]'),auxEffort=ev.target.closest('[data-aux-effort]'),move=ev.target.closest('[data-backup-up],[data-backup-down],[data-backup-remove]');
    if(choice){roleAction('selectDecider',{provider:choice.dataset.decider||null},'Saving decider…');return;}
    if(ev.target.closest('[data-aux-default]')){roleAction('selectAuxiliary',{provider:null,model:null},'Saving auxiliary model…');return;}
    if(auxEffort){roleAction('selectAuxiliary',{provider:modelAux.provider,model:modelAux.model,effort:auxEffort.dataset.auxEffort||null},'Saving auxiliary reasoning…');return;}
    if(ev.target.closest('#addBackup')||ev.target.closest('#cancelBackupAdd')){backupAdding=!!ev.target.closest('#addBackup');E('modelSearch').value='';renderOptions();if(backupAdding)E('modelSearch').focus();return;}
    if(ev.target.closest('#testBackups')){roleAction('testBackups',{},'Testing backups…');return;}
    if(move){var chain=modelBackups.chain.map(function(row){return {provider:row.provider,model:row.model};}),key=Object.prototype.hasOwnProperty.call(move.dataset,'backupUp')?'backupUp':Object.prototype.hasOwnProperty.call(move.dataset,'backupDown')?'backupDown':'backupRemove',index=Number(move.dataset[key]);if(key==='backupRemove')chain.splice(index,1);else{var other=index+(key==='backupUp'?-1:1),item=chain[index];chain[index]=chain[other];chain[other]=item;}roleAction('updateBackups',{update:{chain:chain}},'Saving backup order…');return;}
    if(star){var provider=star.dataset.starProvider,id=star.dataset.starModel,starred=star.getAttribute('aria-pressed')!=='true';modelFavorites=modelFavorites.filter(function(f){return f.provider!==provider||f.model!==id;});if(starred)modelFavorites.push({provider:provider,model:id});renderOptions();vscode.postMessage({type:'favoriteModel',provider:provider,model:id,starred:starred,requestId:++favoriteRequest});}
    else if(model){
      if(modelRole==='aux'){roleAction('selectAuxiliary',{provider:model.dataset.provider,model:model.dataset.model},'Saving auxiliary model…');return;}
      if(modelRole==='backup'){var chain=(modelBackups.chain||[]).map(function(row){return {provider:row.provider,model:row.model};});chain.push({provider:model.dataset.provider,model:model.dataset.model});roleAction('updateBackups',{update:{chain:chain}},'Adding backup…');return;}
      if(optionApplying)return;setOptionBusy(true);E('optionChoices').querySelectorAll('button').forEach(function(b){b.disabled=true;});E('optionStatus').textContent='Updating model…';vscode.postMessage({type:'selectModel',provider:model.dataset.provider,model:model.dataset.model,requestId:optionRequest});}
    else if(effort){if(optionApplying)return;setOptionBusy(true);E('optionChoices').querySelectorAll('button').forEach(function(b){b.disabled=true;});E('optionStatus').textContent='Updating reasoning…';vscode.postMessage({type:'selectEffort',effort:effort.dataset.effort,requestId:optionRequest});}
  });
  E('optionChoices').addEventListener('change',function(ev){var trigger=ev.target.closest('[data-backup-trigger]');if(trigger){if(optionApplying)return;var on=Array.from(E('optionChoices').querySelectorAll('[data-backup-trigger]:checked')).map(function(input){return input.dataset.backupTrigger;});roleAction('updateBackups',{update:{on:on}},'Saving backup triggers…');}});
  window.addEventListener('message',function(ev){var message=ev.data;if(!message||!optionKind)return;if(message.requestId!==optionRequest){if((message.type==='roleApplied'||message.type==='backupTested')&&!optionApplying)vscode.postMessage({type:'modelOptions',requestId:optionRequest});return;}
    if(message.type==='roleApplied'){setOptionBusy(false);if(message.role==='aux')modelAux=message.data;else if(message.role==='decider')modelDecider=message.data;else if(message.role==='backup'){modelBackups=message.data;backupAdding=false;}renderOptions();if(message.data.shared_config_error)E('optionStatus').textContent='Shared configuration was not saved: '+message.data.shared_config_error;}
    else if(message.type==='backupTested'){setOptionBusy(false);backupResults=message.data.results||[];renderOptions();}
  });
  E('optionPicker').addEventListener('keydown',function(ev){if(ev.key==='Escape'){ev.preventDefault();ev.stopPropagation();closeOptions(true);}else if((ev.key==='ArrowLeft'||ev.key==='ArrowRight')&&ev.target.closest('[data-model-role]')){var tabs=Array.from(E('modelRoleTabs').querySelectorAll('button')),index=tabs.indexOf(ev.target);ev.preventDefault();var next=tabs[(index+(ev.key==='ArrowRight'?1:tabs.length-1))%tabs.length];next.click();next.focus();}else if(ev.key==='ArrowDown'||ev.key==='ArrowUp'){var buttons=Array.from(E('optionChoices').querySelectorAll('.option-select'));if(buttons.length){ev.preventDefault();var i=buttons.indexOf(document.activeElement);buttons[i<0?(ev.key==='ArrowDown'?0:buttons.length-1):(i+(ev.key==='ArrowDown'?1:buttons.length-1))%buttons.length].focus();}}});
  document.addEventListener('click',function(ev){if(optionKind&&!E('optionPicker').contains(ev.target)&&!E('modelBtn').contains(ev.target)&&!E('effortBtn').contains(ev.target))closeOptions(false);});window.addEventListener('resize',positionOptions);
`;
