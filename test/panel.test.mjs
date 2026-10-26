import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const load = Module._load;
const uri = path => ({fsPath:path,toString:()=>path});
const warnings=[];
Module._load = function(name,...args) {return name === 'vscode' ? {window:{showWarningMessage:message=>warnings.push(message)},Uri:{file:uri,joinPath:(base,...parts)=>uri([base.fsPath,...parts].join('/'))},ViewColumn:{Active:1},commands:{executeCommand() {}}} : load.call(this,name,...args);};
const {SessionSidebar,SessionPanel} = require('../out/panel.js');
Module._load = load;
const {SessionStore} = require('../out/store.js');
const {SessionController} = require('../out/manager.js');
const {splitTextFileReferences} = require('../out/text-attachments.js');
function event() {const listeners=new Set();return {register:fn=>{listeners.add(fn);return {dispose:()=>listeners.delete(fn)};},fire:arg=>{for(const fn of [...listeners])fn(arg);}};}
function controller(id) {
  const store = new SessionStore();
  store.setThreads([],id);
  return {sessionId:id,store,closeTextAttachments(){},commitTextAttachments:async()=>{},releasePreparedTextAttachments:async()=>{},releaseTextAttachment:async()=>{},rpc:{connectionState:'connected',attempts:0},subscribeConnection:()=>({dispose(){}}),imageUrl:key=>'https://example.com/'+key};
}

test('sidebar switches subscriptions, queues context until ready and keeps current DOM', () => {
  const received=event(), disposed=event(), visibility=event();
  const posted=[];
  const view={visible:true,title:'Nodecode',show(){},onDidDispose:disposed.register,onDidChangeVisibility:visibility.register,webview:{html:'',cspSource:'https://webview.local',asWebviewUri:u=>u,postMessage:m=>posted.push(m),onDidReceiveMessage:received.register}};
  const sidebar=new SessionSidebar(uri('/extension'),{}, {log(){}});
  const first=controller('first'),second=controller('second');
  sidebar.restore(first);
  sidebar.resolveWebviewView(view);
  sidebar.addContext('context before ready');
  assert(!posted.some(m=>m.type==='addContext'));
  received.fire({type:'ready'});
  assert(posted.some(m=>m.type==='addContext' && m.text==='context before ready'));
  const html=view.webview.html;
  sidebar.show(first);
  assert.equal(view.webview.html, html);
  sidebar.show(second);
  posted.length=0;
  first.store.applyFrame({type:'session_titled',title:'old'});
  assert.equal(posted.length,0);
  second.store.applyFrame({type:'session_titled',title:'new'});
  assert.equal(posted.at(-1).view.title,'new');
  assert.equal(view.title,'Nodecode');
  sidebar.dispose();
  posted.length=0;
  second.store.applyFrame({type:'session_titled',title:'disposed'});
  assert.equal(posted.length,0);
});


test('deleting the selected session clears its sidebar without reattaching it', () => {
  const received=event(), disposed=event(), visibility=event();
  const view={visible:true,title:'Nodecode',show(){},onDidDispose:disposed.register,onDidChangeVisibility:visibility.register,webview:{html:'',cspSource:'https://webview.local',asWebviewUri:u=>u,postMessage(){},onDidReceiveMessage:received.register}};
  const sidebar=new SessionSidebar(uri('/extension'),{listSessions:async()=>[]}, {log(){}});
  const selected=controller('deleted');
  sidebar.restore(selected);sidebar.resolveWebviewView(view);
  sidebar.clearSessions(['other']);
  assert(view.webview.html.includes('id="composer"'));
  sidebar.clearSessions(['deleted']);
  assert(!view.webview.html.includes('id="composer"'));
  assert(view.webview.html.includes('id="sessionPicker"'));
  assert.equal(view.title,'Nodecode');
  selected.store.applyFrame({type:'session_titled',title:'stale update'});
  assert.equal(view.title,'Nodecode');
  sidebar.dispose();
});


test('a late acknowledgement cannot clear the newly selected session composer', async () => {
  const received=event(), disposed=event(), visibility=event(), posted=[];
  const view={visible:true,title:'Nodecode',show(){},onDidDispose:disposed.register,onDidChangeVisibility:visibility.register,webview:{html:'',cspSource:'https://webview.local',asWebviewUri:u=>u,postMessage:m=>posted.push(m),onDidReceiveMessage:received.register}};
  const sidebar=new SessionSidebar(uri('/extension'),{}, {log(){}});
  const first=controller('first'),second=controller('second');
  let acknowledge;
  first.withAttachments=async text=>text;
  first.queuePrompt=()=>({done:new Promise(resolve=>{acknowledge=resolve;})});
  sidebar.restore(first);sidebar.resolveWebviewView(view);
  received.fire({type:'send',requestId:'old-draft',text:'old draft'});
  await new Promise(setImmediate);
  sidebar.show(second);posted.length=0;
  acknowledge({status:'accepted'});
  await new Promise(setImmediate);
  assert(!posted.some(m=>m.type==='sendAccepted'||m.type==='sendRejected'));
  sidebar.dispose();
});


test('late welcome search cannot populate a new welcome document after a session switch', async () => {
  const received=event(), disposed=event(), visibility=event(), posted=[];
  const view={visible:true,title:'Nodecode',show(){},onDidDispose:disposed.register,onDidChangeVisibility:visibility.register,webview:{html:'',cspSource:'https://webview.local',asWebviewUri:u=>u,postMessage:m=>posted.push(m),onDidReceiveMessage:received.register}};
  let finish;
  const sidebar=new SessionSidebar(uri('/extension'),{listSessions:()=>new Promise(resolve=>{finish=resolve;})},{log(){}});
  sidebar.resolveWebviewView(view);
  received.fire({type:'requestSessions',query:'old',requestId:1});
  const selected=controller('temporary');sidebar.show(selected);sidebar.clearSessions(['temporary']);posted.length=0;
  finish([{id:'stale',title:'Stale result'}]);await new Promise(setImmediate);
  assert(!posted.some(m=>m.type==='sessions'));
  sidebar.dispose();
});


test('native tool image projection permits inline PNG and in-workspace images only', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nodecode-tool-image-'));
  const panel=Object.create(SessionPanel.prototype);
  panel.panel={webview:{options:{},asWebviewUri:u=>({toString:()=>`safe:${u.fsPath}`})}};
  try{
    const file=path.join(root,'preview.png');fs.writeFileSync(file,'image');
    assert.equal(panel.toolImageUrl({metadata:{image:{}},result:'data:image/png;base64,aGVsbG8='},root),'data:image/png;base64,aGVsbG8=');
    assert.equal(panel.toolImageUrl({metadata:{image:{path:'preview.png'}}},root),`safe:${fs.realpathSync(file)}`);
    assert.equal(panel.toolImageUrl({metadata:{image:{path:'/outside/missing.png'}}},root),undefined);
    assert.equal(panel.toolImageUrl({metadata:{image:{path:'preview.svg'}}},root),undefined);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('conversation menu awaits action failures and reports them through the panel error handler', async t => {
  for(const [action,callback] of [
    ['fork','forkSession'],['rename','renameSession'],['export','exportSession'],
    ['revealTerminal','revealTerminal'],['delete','deleteSession'],
    ['checkpointHistory','showCheckpointHistory'],['pickModel','pickModel'],['pickEffort','pickEffort'],
  ]) await t.test(action,async()=>{
    const failure=Promise.reject(new Error(`${action} unavailable`));
    failure.catch(()=>{});
    const logs=[];
    warnings.length=0;
    const panel=Object.create(SessionPanel.prototype);
    panel.controller={sessionId:'session'};
    panel.callbacks={[callback]:()=>failure};
    panel.notes={log:message=>logs.push(message)};
    await panel.onMessage({type:action});
    assert.equal(logs.length,1,'action rejection must reach the panel error handler');
    assert.match(logs[0],new RegExp(`${action} unavailable`));
    assert.equal(warnings.length,1,'action failure must be visible to the user');
  });
});

test('control actions report disconnected and rejected command results',async t=>{
  for(const [action,method] of [['withdraw','withdraw'],['cancel','cancelActive'],['interrupt','interruptExec'],['navigateUndo','navigateCheckpoint'],['navigateRedo','navigateCheckpoint']]){
    for(const result of [undefined,{status:'rejected',message:'Runtime refused control'}])await t.test(`${action} ${result?'rejected':'disconnected'}`,async()=>{
      const panel=Object.create(SessionPanel.prototype),logs=[];warnings.length=0;
      panel.controller={sessionId:'session',[method]:()=>method==='navigateCheckpoint'?Promise.resolve(result):result&&{done:Promise.resolve(result)}};
      panel.notes={log:m=>logs.push(m)};
      await panel.onMessage({type:action,promptId:'queued',execId:1});
      assert.equal(warnings.length,1);assert.equal(logs.length,1);
      assert.match(warnings[0],result?/Runtime refused control/:/not connected/i);
    });
  }
});

test('pending send acknowledgement follows its original session across sidebar recreation without resubmitting',async()=>{
  const received=event(),disposed=event(),visibility=event(),posted=[];
  const view={visible:true,title:'Nodecode',show(){},onDidDispose:disposed.register,onDidChangeVisibility:visibility.register,webview:{html:'',cspSource:'https://webview.local',asWebviewUri:u=>u,postMessage:m=>posted.push(m),onDidReceiveMessage:received.register}};
  const sidebar=new SessionSidebar(uri('/extension'),{},{log(){}}),first=controller('resumed'),second=controller('other');
  let finish,sends=0;
  first.withAttachments=async text=>text;first.queuePrompt=()=>{sends++;return {done:new Promise(resolve=>{finish=resolve;})};};
  first.commitTextAttachments=()=>{};
  sidebar.restore(first);sidebar.resolveWebviewView(view);
  received.fire({type:'send',requestId:'original-send',text:'Original prompt'});await new Promise(setImmediate);
  sidebar.show(second);sidebar.show(first);posted.length=0;
  received.fire({type:'ready',pendingSendId:'original-send'});await new Promise(setImmediate);
  finish({status:'accepted'});await new Promise(setImmediate);
  assert.equal(sends,1);assert(posted.some(m=>m.type==='sendAccepted'&&m.requestId==='original-send'));
  received.fire({type:'send',requestId:'original-send',text:'Original prompt'});await new Promise(setImmediate);
  assert.equal(sends,1,'an acknowledgement retry must not enqueue another prompt');
  sidebar.dispose();
});

test('a pending send lost with the extension host is explicitly outcome-unknown, never resubmitted',async()=>{
  const panel=Object.create(SessionPanel.prototype),posted=[];
  panel.controller=controller('missing-send');panel.panel={webview:{postMessage:m=>posted.push(m)}};
  panel.pendingHistory=false;panel.pendingContext=[];panel.notes={log(){}};
  await panel.onMessage({type:'ready',pendingSendId:'not-in-host'});
  assert.equal(posted.find(m=>m.type==='sendRejected')?.requestId,'not-in-host');
  assert.equal(posted.find(m=>m.type==='sendRejected')?.outcomeUnknown,true);
});

test('history browsing state survives active session changes and welcome restoration', () => {
  const received=event(), disposed=event(), visibility=event(), posted=[];
  const view={visible:true,title:'Nodecode',show(){},onDidDispose:disposed.register,onDidChangeVisibility:visibility.register,webview:{html:'',cspSource:'https://webview.local',asWebviewUri:u=>u,postMessage:m=>posted.push(m),onDidReceiveMessage:received.register}};
  const sidebar=new SessionSidebar(uri('/extension'),{}, {log(){}});
  sidebar.restore(controller('first'));sidebar.resolveWebviewView(view);
  const state={open:true,query:'needle',mode:'lineage',scroll:123};
  received.fire({type:'historyBrowserState',state});
  sidebar.show(controller('second'));posted.length=0;received.fire({type:'ready'});
  assert.deepEqual(posted.find(m=>m.type==='historyRestore')?.state,state);
  sidebar.clearSessions(['second']);posted.length=0;received.fire({type:'ready'});
  assert.deepEqual(posted.find(m=>m.type==='historyRestore')?.state,state);
  sidebar.dispose();
});


test('send settlement commits admitted files and reclaims only rejected generated files',async t=>{
  for(const outcome of ['accepted','unknown','rejected','disconnected'])await t.test(outcome,async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'nodecode-send-files-'));
    const ctl=new SessionController({},{log(){}},{assertLocalRuntimeFiles:async()=>{}},root,'lifecycle-'+outcome,root);
    const panel=Object.create(SessionPanel.prototype),posted=[];
    panel.controller=ctl;panel.attachmentSource={};panel.notes={log(){}};panel.panel={webview:{postMessage:m=>posted.push(m)}};
    let finish,prepared;
    ctl.queuePrompt=prompt=>{prepared=prompt;return outcome==='disconnected'?undefined:{done:new Promise(resolve=>{finish=resolve;})};};
    try{
      const selected=(await ctl.stageTextAttachmentChunk({text:'selected draft',name:'selected.txt',requestId:1,index:0,totalChunks:1},panel.attachmentSource)).attachment;
      const pending=panel.onMessage({type:'send',requestId:'files-'+outcome,text:'L'.repeat(200001),textFiles:[selected.ref]});
      for(let i=0;i<100&&!prepared;i++)await new Promise(resolve=>setTimeout(resolve,5));
      assert(prepared,'send should finish attachment preparation');
      const files=splitTextFileReferences(prepared).textFiles;
      assert.equal(files.length,2);
      if(outcome!=='disconnected'){
        // Closing the composer must not cancel an in-flight submission's ownership.
        ctl.closeTextAttachments(panel.attachmentSource);
        await ctl.releaseTextAttachment(selected.ref,{});
        assert(fs.existsSync(selected.path),'the independent send owner pins files after the composer closes');
        finish(outcome==='accepted'?{status:'accepted'}:{status:'rejected',...(outcome==='unknown'?{code:'acknowledgement_unknown'}:{}),message:outcome});
      }
      await pending;
      const admitted=outcome==='accepted'||outcome==='unknown';
      assert.equal(posted.at(-1).type,outcome==='accepted'?'sendAccepted':'sendRejected');
      for(const file of files){
        if(admitted||file.ref===selected.ref){
          assert(fs.existsSync(file.path),'history and selected drafts survive');
          const metadata=JSON.parse(fs.readFileSync(file.path.replace(/\.txt$/,'.json'),'utf8'));
          assert.equal(metadata.draft,!admitted);
        }else assert.equal(fs.existsSync(file.path),false,'definitively rejected automatic file is reclaimed');
      }
    }finally{ctl.dispose();fs.rmSync(root,{recursive:true,force:true});}
  });
});


test('cleanup failure after known admission is a warning, not a rejected send',async()=>{
  const panel=Object.create(SessionPanel.prototype),posted=[];
  panel.controller={store:new SessionStore(),withAttachments:async()=> 'prepared',queuePrompt:()=>({done:Promise.resolve({status:'accepted'})}),
    commitTextAttachments:async()=>{},releaseTextAttachment:async()=>{throw new Error('cleanup failed');},closeTextAttachments(){}};
  panel.attachmentSource={};panel.notes={log(){}};panel.panel={webview:{postMessage:m=>posted.push(m)}};
  await panel.onMessage({type:'send',requestId:'accepted-with-cleanup-error',text:'sent',textFiles:['selected-ref']});
  assert.equal(posted.at(-1).type,'sendAccepted');assert.match(posted.at(-1).message,/cleanup failed/);
});


test('completed receipt pruning never evicts an unresolved submission',async()=>{
  const panel=Object.create(SessionPanel.prototype),posted=[];
  const ctl=controller('long-pending');let finish,sends=0;
  ctl.withAttachments=async text=>text;
  ctl.queuePrompt=()=>({done:++sends===1?new Promise(resolve=>{finish=resolve;}):Promise.resolve({status:'accepted'})});
  panel.controller=ctl;panel.attachmentSource={};panel.notes={log(){}};panel.panel={webview:{postMessage:m=>posted.push(m)}};
  const first=panel.onMessage({type:'send',requestId:'still-pending',text:'slow submission'});
  await new Promise(setImmediate);
  for(let i=0;i<40;i++)await panel.onMessage({type:'send',requestId:'completed-'+i,text:'other view submission'});
  assert(panel.sendReceipt('still-pending'),'an unresolved identity must not be pruned');
  const retry=panel.onMessage({type:'send',requestId:'still-pending',text:'slow submission'});
  await new Promise(setImmediate);assert.equal(sends,41,'retry waits for the existing submission');
  finish({status:'accepted'});await Promise.all([first,retry]);
  assert(posted.some(m=>m.type==='sendAccepted'&&m.requestId==='still-pending'));
  assert.equal(panel.sendReceipt('completed-0'),undefined,'old completed receipts remain bounded');
});

test('active sends capture their steering target before attachment preparation and never fall back to queuing',async t=>{
  for(const explicit of [false,true])await t.test(explicit?'explicit steering':'default active send',async()=>{
    const ctl=controller('steer-target-'+explicit),panel=Object.create(SessionPanel.prototype),posted=[],commands=[];
    panel.controller=ctl;panel.attachmentSource={};panel.notes={log(){}};panel.panel={webview:{postMessage:m=>posted.push(m)}};
    ctl.store.applyFrame({type:'session_stream_event',sequence:1,turn_id:'turn-A',event:{type:'turn.started',payload:{}}});
    let finishPreparation;
    ctl.withAttachments=()=>new Promise(resolve=>{finishPreparation=resolve;});
    ctl.steer=(turnId,text)=>{commands.push({turnId,text});return {done:Promise.resolve({status:'rejected',message:'The active turn changed'})};};
    ctl.sendPrompt=()=>{throw new Error('must not submit a different turn')};ctl.queuePrompt=()=>{throw new Error('must not queue a rejected steer')};
    const pending=panel.onMessage({type:'send',requestId:'stale-target',text:'Correct the approach',...(explicit?{mode:'steer',turnId:'turn-A'}:{})});
    await new Promise(setImmediate);
    ctl.store.applyFrame({type:'session_stream_event',sequence:2,turn_id:'turn-A',event:{type:'turn.completed',payload:{}}});
    ctl.store.applyFrame({type:'session_stream_event',sequence:3,turn_id:'turn-B',event:{type:'turn.started',payload:{}}});
    finishPreparation('Correct the approach with attachments');await pending;
    assert.deepEqual(commands,[{turnId:'turn-A',text:'Correct the approach with attachments'}]);
    assert.equal(posted.at(-1).type,'sendRejected');assert.match(posted.at(-1).message,/active turn changed/);
  });
});

test('explicit queue sends keep their own route and malformed steering is rejected rather than sent normally',async()=>{
  const ctl=controller('explicit-queue'),panel=Object.create(SessionPanel.prototype),posted=[],commands=[];
  panel.controller=ctl;panel.attachmentSource={};panel.notes={log(){}};panel.panel={webview:{postMessage:m=>posted.push(m)}};
  ctl.withAttachments=async text=>text;
  ctl.queuePrompt=text=>{commands.push(text);return {done:Promise.resolve({status:'queued'})};};
  ctl.sendPrompt=()=>{throw new Error('must not use automatic send')};
  await panel.onMessage({type:'send',requestId:'queue',mode:'queue',text:'Wait until this response is done'});
  assert.deepEqual(commands,['Wait until this response is done']);assert.equal(posted.at(-1).type,'sendAccepted');
  await panel.onMessage({type:'send',requestId:'bad-steer',mode:'steer',text:'Do not silently queue this'});
  assert.equal(posted.at(-1).type,'sendRejected');assert.match(posted.at(-1).message,/steer.*turn|turn.*steer/i);
  assert.equal(commands.length,1);
});

test('idle sends retain start-or-queue intent when another client starts work during attachment preparation',async()=>{
  const ctl=controller('idle-route'),panel=Object.create(SessionPanel.prototype),posted=[],commands=[];
  panel.controller=ctl;panel.attachmentSource={};panel.notes={log(){}};panel.panel={webview:{postMessage:m=>posted.push(m)}};
  let finishPreparation;
  ctl.withAttachments=()=>new Promise(resolve=>{finishPreparation=resolve;});
  ctl.sendPrompt=SessionController.prototype.sendPrompt;
  ctl.queuePrompt=text=>{commands.push({type:'start_turn',text});return {done:Promise.resolve({status:'queued'})};};
  ctl.steer=(turnId,text)=>{commands.push({type:'steer_turn',turnId,text});return {done:Promise.resolve({status:'accepted'})};};
  const pending=panel.onMessage({type:'send',requestId:'idle-to-active',text:'Start this separate task'});
  await new Promise(setImmediate);
  ctl.store.applyFrame({type:'session_stream_event',sequence:1,turn_id:'unrelated-turn',event:{type:'turn.started',payload:{}}});
  finishPreparation('Start this separate task with attachments');await pending;
  assert.deepEqual(commands,[{type:'start_turn',text:'Start this separate task with attachments'}]);
  assert.equal(posted.at(-1).type,'sendAccepted');
});
