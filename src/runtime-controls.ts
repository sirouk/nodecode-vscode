// Shared runtime status controls for the welcome screen and active conversation.
export const RUNTIME_MARKUP = `<div id="runtimeBanner" class="hidden" role="status"><span id="runtimeMessage"></span><div><button id="runtimeRetry">Retry</button><button id="runtimeInstall">Install Nodecode</button></div></div>`;

export const RUNTIME_CLIENT_JS = String.raw`
  var runtimeState,runtimeBusy=false,runtimeRequest=0;
  function renderRuntime(status){
    runtimeState=status;runtimeBusy=false;
    E('runtimeBanner').classList.toggle('hidden',status.state==='ready');
    E('runtimeMessage').textContent=status.message||'';
    E('runtimeInstall').classList.toggle('hidden',status.state!=='missing-cli'&&status.state!=='unusable-cli');
    E('runtimeInstall').disabled=false;E('runtimeRetry').disabled=false;
    if(E('restartBtn')){E('restartBtn').disabled=!status.canRestart;E('restartBtn').title=status.canRestart?'Restart the native Nodecode service':status.message;}
  }
  function requestRuntime(type){
    if(runtimeBusy)return;runtimeBusy=true;var requestId=++runtimeRequest;
    if(type!=='runtimeStatus')E('runtimeBanner').classList.remove('hidden');
    E('runtimeRetry').disabled=true;E('runtimeInstall').disabled=true;if(E('restartBtn'))E('restartBtn').disabled=true;
    E('runtimeMessage').textContent=type==='restartRuntime'?'Restarting Nodecode…':'Checking Nodecode…';vscode.postMessage({type:type,requestId:requestId});
  }
  E('runtimeRetry').addEventListener('click',function(){requestRuntime('retryRuntime');});
  E('runtimeInstall').addEventListener('click',function(){if(runtimeBusy)return;vscode.postMessage({type:'installRuntime',requestId:++runtimeRequest});E('runtimeInstall').disabled=true;E('runtimeMessage').textContent='Installer opened in the terminal. Retry after it finishes.';});
  if(E('restartBtn'))E('restartBtn').addEventListener('click',function(){E('menuWrap').open=false;requestRuntime('restartRuntime');});
  window.addEventListener('message',function(ev){var message=ev.data;if(!message||message.requestId!==undefined&&message.requestId!==runtimeRequest)return;if(message.type==='runtimeStatus')renderRuntime(message.status);else if(message.type==='runtimeError'){runtimeBusy=false;E('runtimeBanner').classList.remove('hidden');E('runtimeMessage').textContent=message.message;E('runtimeRetry').disabled=false;E('runtimeInstall').disabled=false;if(E('restartBtn'))E('restartBtn').disabled=!runtimeState||!runtimeState.canRestart;}});
  var metadataRequest=0,runtimeMetadata;
  if(E('runtimeVersionBtn')){
    E('menuWrap').addEventListener('toggle',function(){if(E('menuWrap').open)vscode.postMessage({type:'runtimeMetadata',requestId:++metadataRequest});});
    E('runtimeVersionBtn').addEventListener('click',function(){if(runtimeMetadata){E('menuWrap').open=false;vscode.postMessage({type:'openExternal',url:runtimeMetadata.releaseUrl});}});
    window.addEventListener('message',function(ev){var m=ev.data;if(!m||m.type!=='runtimeMetadata'||m.requestId!==metadataRequest)return;var button=E('runtimeVersionBtn');if(m.error){button.textContent='Nodecode CLI version unavailable';button.title=m.error;button.disabled=true;return;}runtimeMetadata=m.data;button.textContent='Nodecode CLI '+m.data.version;button.disabled=false;var details=['Nodecode CLI '+m.data.version];details.push(m.data.releaseTag?'GitHub release '+m.data.releaseTag:'Matching GitHub release unavailable; opens the releases page.');if(m.data.releasePublishedAt)details.push('Released '+new Date(m.data.releasePublishedAt).toLocaleString());if(m.data.binaryUpdatedAt)details.push('Binary updated '+new Date(m.data.binaryUpdatedAt).toLocaleString());button.title=details.join('\n');});
  }
  requestRuntime('runtimeStatus');
`;
