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
  return {sessionId:id,store,closeTextAttachments(){},commitTextAttachments:async()=>{},releasePreparedTextAttachments:async()=>{},releaseTextAttachment:async()=>{},rpc:{connectionState:'connected',attempts:0},subscribeConnection:()=>({dispose(){}}),imageDataUrl:async()=> 'data:image/png;base64,aGVsbG8='};
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


test('thread navigation carries disclosure state through the host and waits for the target document',async()=>{
  const received=event(),disposed=event(),visibility=event(),posted=[];
  const view={visible:true,title:'Nodecode',show(){},onDidDispose:disposed.register,onDidChangeVisibility:visibility.register,webview:{html:'',cspSource:'https://webview.local',asWebviewUri:u=>u,postMessage:m=>posted.push(m),onDidReceiveMessage:received.register}};
  const sidebar=new SessionSidebar(uri('/extension'),{},{log(){}}),target=controller('child');
  const source=Object.create(SessionPanel.prototype),opened=[];
  source.controller=controller('parent');source.notes={log(){}};
  source.callbacks={openSession:(id,navigation)=>{opened.push(id);sidebar.show(target,navigation);}};
  const navigation={open:true,idleOpen:true};
  await source.onMessage({type:'openThread',sessionId:'parent',threadNavigation:navigation});
  assert.deepEqual(opened,[],'the selected thread is a host-side no-op too');
  await source.onMessage({type:'openThread',sessionId:'child',threadNavigation:navigation});
  assert.deepEqual(opened,['child']);
  sidebar.resolveWebviewView(view);
  assert(!posted.some(m=>m.type==='threadNavigationRestore'),'restoration must wait for the new document');
  received.fire({type:'ready'});
  assert.deepEqual(posted.find(m=>m.type==='threadNavigationRestore')?.state,navigation);
  assert.equal(posted.find(m=>m.type==='state')?.view.sessionId,'child');
  posted.length=0;
  sidebar.show(target,{open:true,idleOpen:false});
  assert.deepEqual(posted.find(m=>m.type==='threadNavigationRestore')?.state,{open:true,idleOpen:false},'an already attached sidebar receives editor navigation without being replaced');
  sidebar.show(controller('sibling'),navigation);posted.length=0;received.fire({type:'ready'});
  assert.deepEqual(posted.find(m=>m.type==='threadNavigationRestore')?.state,navigation,'state follows sibling document replacement');
  sidebar.dispose();
});

test('status and usage follow the complete composer before the keyboard hint', () => {
  const panel=Object.create(SessionPanel.prototype);
  panel.controller={sessionId:'layout-session'};
  panel.panel={webview:{cspSource:'https://webview.local'}};
  panel.markUri='https://webview.local/icon.svg';
  panel.markdownUri='https://webview.local/markdown.js';
  const html=panel.html(),composer=html.indexOf('<footer id="composerBar">');
  const end=html.indexOf('</footer>',composer),status=html.indexOf('<div id="statusLine"'),hint=html.indexOf('<div id="composerHint"');
  assert(composer>=0&&end>composer);
  assert(status>end,'the status row must follow the input and its action buttons');
  assert(hint>status,'the keyboard hint remains beneath the status row');
  assert.equal(html.split('id="statusLine"').length,2,'only one live status row is rendered');
  assert(html.includes('<div id="statusLine" role="status" aria-live="polite"></div>'));
});


test('the extension ships a bounded transcript tail and answers scroll-back requests', async () => {
  const posted=[];
  const parts=Array.from({length:600},(_,i)=>({kind:i%2===0?'user':'assistant',turnNumber:i,text:'part '+i}));
  const panel=Object.create(SessionPanel.prototype);
  panel.conversationImages=new Map(); // Object.create skips field initializers
  panel.controller={sessionId:'windowed',store:{replaying:false,view:()=>({sessionId:'windowed',cwd:'/work',title:'windowed',parts}),userPrompts:()=>[]}};
  panel.panel={webview:{postMessage:m=>posted.push(m)}};
  panel.postMessage=m=>{panel.panel.webview.postMessage(m);};
  panel.postState();
  const state=posted.find(m=>m.type==='state').view;
  assert.equal(state.parts.length,240,'a long thread must not be serialized across the bridge on every token');
  assert(state.parts.length<parts.length/2);
  assert.equal(state.partsStart,360);
  assert.equal(state.partsTotal,600,'the panel still knows how much history exists');
  assert.equal(state.parts[0].text,'part 360');
  posted.length=0;
  await panel.onMessage({type:'requestParts',requestId:7,before:360,limit:200});
  const win=posted.find(m=>m.type==='partsWindow');
  assert.equal(win.sessionId,'windowed');
  assert.equal(win.requestId,7);
  assert.equal(win.start,160);
  assert.equal(win.total,600);
  assert.equal(win.parts.length,200);
  assert.equal(win.parts[0].text,'part 160');
  assert.equal(win.parts[199].text,'part 359','the answer ends where the shipped tail begins so the cache stays contiguous');
  posted.length=0;
  await panel.onMessage({type:'requestParts',requestId:8,before:50,limit:5000});
  assert.deepEqual([posted[0].start,posted[0].parts.length],[0,50],'a request cannot reach before the beginning of the transcript');
  posted.length=0;
  await panel.onMessage({type:'requestParts',requestId:9,before:600});
  assert.deepEqual([posted[0].start,posted[0].parts.length],[400,200]);
  // A slice loaded on demand is decorated exactly like the shipped tail: an older
  // tool row still carries the image it was rendered from. Nothing else here would
  // notice that mapping being dropped.
  posted.length=0;
  const shot={kind:'tool',turnNumber:9,call:{callId:'shot',name:'screenshot',arguments:'{}',result:'data:image/png;base64,aGVsbG8=',done:true,status:'done',metadata:{image:{}}}};
  panel.controller={sessionId:'windowed',store:{replaying:false,view:()=>({sessionId:'windowed',cwd:'/work',title:'windowed',parts:[shot].concat(parts)}),userPrompts:()=>[]}};
  await panel.onMessage({type:'requestParts',requestId:10,before:1,limit:1});
  assert.equal(posted.find(m=>m.type==='partsWindow').parts[0].call.imageUrl,'data:image/png;base64,aGVsbG8=','the older slice is decorated like the tail');

  // A slice cut while the session is still replaying would freeze rows that are
  // not finished being built above the tail, where no later state reaches them.
  const settledController=panel.controller;
  panel.controller={sessionId:'windowed',store:{replaying:true,view:()=>({sessionId:'windowed',cwd:'/work',title:'windowed',parts}),userPrompts:()=>[]}};
  posted.length=0;
  await panel.onMessage({type:'requestParts',requestId:11,before:100,limit:50});
  assert(!posted.some(m=>m.type==='partsWindow'),'a replaying session does not answer a slice request');
  panel.controller=settledController;
  await panel.onMessage({type:'requestParts',requestId:12,before:100,limit:50});
  assert.equal(posted.find(m=>m.type==='partsWindow').requestId,12,'and answers the same request once the replay is done');

  // A saved image still resolving when its slice ships would leave that row
  // saying 'Loading image...' forever: only the tail is posted again.
  let releaseImage;
  const withImage={kind:'user',turnNumber:8,text:'see this',images:[{id:'pending-shot',mediaType:'image/png'}]};
  panel.controller={sessionId:'windowed',store:{replaying:false,view:()=>({sessionId:'windowed',cwd:'/work',title:'windowed',parts:[withImage].concat(parts)}),userPrompts:()=>[]},imageDataUrl:()=>new Promise(resolve=>{releaseImage=resolve;})};
  posted.length=0;
  await panel.onMessage({type:'requestParts',requestId:13,before:1,limit:1});
  await new Promise(setImmediate);
  assert(!posted.some(m=>m.type==='partsWindow'),'the slice waits for the image it shows');
  releaseImage('data:image/png;base64,aGVsbG8=');
  for(let i=0;i<200&&!posted.some(m=>m.type==='partsWindow');i++)await new Promise(setImmediate);
  assert.equal(posted.find(m=>m.type==='partsWindow').parts[0].images[0].url,'data:image/png;base64,aGVsbG8=','and carries it once it resolves');

  // An image that never resolves must not wedge scroll back either: the slice
  // ships without it after a bounded wait.
  const neverImage={kind:'user',turnNumber:8,text:'see this',images:[{id:'never-shot',mediaType:'image/png'}]};
  panel.controller={sessionId:'windowed',store:{replaying:false,view:()=>({sessionId:'windowed',cwd:'/work',title:'windowed',parts:[neverImage].concat(parts)}),userPrompts:()=>[]},imageDataUrl:()=>new Promise(()=>{})};
  const realSettleMs=Object.getOwnPropertyDescriptor(SessionPanel,'sliceImageSettleMs');
  Object.defineProperty(SessionPanel,'sliceImageSettleMs',{value:20,configurable:true});
  posted.length=0;
  await panel.onMessage({type:'requestParts',requestId:14,before:1,limit:1});
  for(let i=0;i<200&&!posted.some(m=>m.type==='partsWindow');i++)await new Promise(r=>setTimeout(r,5));
  const late=posted.find(m=>m.type==='partsWindow');
  assert.equal(late.requestId,14,'a slice with an unresolvable image still ships');
  assert.equal(late.parts[0].images[0].url,undefined,'without the url it never got');
  Object.defineProperty(SessionPanel,'sliceImageSettleMs',realSettleMs);
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
      panel.controller={...controller('session'),[method]:()=>method==='navigateCheckpoint'?Promise.resolve(result):result&&{done:Promise.resolve(result)}};
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

test('cached history is a readonly preview even if stale webview messages try to send or control the turn',async()=>{
  const panel=Object.create(SessionPanel.prototype),posted=[],commands=[];
  panel.controller={...controller('cached'),store:{view:()=>({cached:true,running:true,activeTurnId:'old',activeTurnSteerable:true})},withAttachments:async text=>text,steer:()=>commands.push('steer'),queuePrompt:()=>commands.push('queue'),withdraw:()=>commands.push('withdraw'),cancelActive:()=>commands.push('cancel')};
  panel.panel={webview:{postMessage:m=>posted.push(m)}};panel.notes={log(){}};warnings.length=0;
  await panel.onMessage({type:'send',requestId:'cached-send',text:'Never admit from cache'});
  assert.match(posted.find(m=>m.type==='sendRejected').message,/synchroniz/i);
  for(const type of ['withdraw','cancel'])await panel.onMessage({type,promptId:'stale'});
  assert.deepEqual(commands,[]);assert.equal(warnings.length,2);
});

test('controller deduplicates saved-image requests and retains successful sources without retaining failures',async()=>{
  let resolveImage,requests=0,fail=false;
  const api={imageDataUrl:()=>{requests++;return fail?Promise.reject(new Error('gateway 401')):new Promise(resolve=>{resolveImage=resolve;});}};
  const ctl=new SessionController({},{log(){}},api,'/workspace','images');
  try{
    const first=ctl.imageDataUrl('same'),second=ctl.imageDataUrl('same');
    assert.equal(first,second);assert.equal(requests,1);
    resolveImage('data:image/png;base64,aGVsbG8=');assert.equal(await first,'data:image/png;base64,aGVsbG8=');
    assert.equal(await ctl.imageDataUrl('same'),'data:image/png;base64,aGVsbG8=');assert.equal(requests,1);
    fail=true;await assert.rejects(ctl.imageDataUrl('failed'),/401/);await assert.rejects(ctl.imageDataUrl('failed'),/401/);assert.equal(requests,3);
  }finally{ctl.dispose();}
  await assert.rejects(ctl.imageDataUrl('same'),/closed|disposed/i);
});

test('cached user and assistant images resolve asynchronously without blocking transcript or leaking stale session results',async()=>{
  const received=event(),disposed=event(),visibility=event(),posted=[];
  const view={visible:true,title:'Nodecode',show(){},onDidDispose:disposed.register,onDidChangeVisibility:visibility.register,webview:{html:'',cspSource:'https://webview.local',asWebviewUri:u=>u,postMessage:m=>posted.push(m),onDidReceiveMessage:received.register}};
  const sidebar=new SessionSidebar(uri('/extension'),{}, {log(){}}),first=controller('image-history'),other=controller('other-image-history');
  const pending=new Map();let requests=0;
  first.imageDataUrl=id=>{requests++;return new Promise((resolve,reject)=>pending.set(id,{resolve,reject}));};
  first.store.applyFrame({type:'session_stream_resumed',session_id:first.sessionId,replay_chunk_final:true,accumulated_frames:[
    {type:'session_stream_event',session_id:first.sessionId,sequence:1,event:{type:'turn.input_committed',payload:{role:'user',message:'Image question',metadata:{images:[{id:'user-image',media_type:'image/png'}]}}}},
    {type:'session_stream_event',session_id:first.sessionId,sequence:2,event:{type:'turn.assistant_message_completed',payload:{message:'Image answer',metadata:{images:[{id:'assistant-image',media_type:'image/jpeg'}]}}}}
  ]});
  const saved=new SessionStore();saved.restoreProjection(JSON.parse(JSON.stringify(first.store.snapshotProjection())),first.sessionId);first.store=saved;
  try{
    sidebar.restore(first);sidebar.resolveWebviewView(view);
    assert.equal(requests,2);assert.equal(posted.at(-1).view.cached,true);assert.equal(posted.at(-1).view.parts[0].text,'Image question');
    assert.equal(posted.at(-1).view.parts[0].images[0].url,undefined,'no broken or credential-bearing URL is projected while loading');
    first.store.applyFrame({type:'session_titled',title:'A title update while images load'});assert.equal(requests,2);
    pending.get('user-image').resolve('data:image/png;base64,aGVsbG8=');await new Promise(setImmediate);
    assert.equal(posted.at(-1).view.parts[0].images[0].url,'data:image/png;base64,aGVsbG8=');assert.equal(requests,2);
    pending.get('assistant-image').reject(new Error('gateway GET image -> 401'));await new Promise(setImmediate);
    assert.match(posted.at(-1).view.parts[1].images[0].error,/401/);
    first.store.applyFrame({type:'session_titled',title:'Another stream update'});assert.equal(requests,2,'failed images must not retry on every streamed update');
    const old=controller('old-images');let finishOld;
    old.imageDataUrl=()=>new Promise(resolve=>{finishOld=resolve;});
    old.store.applyFrame({type:'session_stream_event',session_id:old.sessionId,sequence:1,event:{type:'turn.input_committed',payload:{message:'Old image',metadata:{images:[{id:'late',media_type:'image/png'}]}}}});
    sidebar.show(old);sidebar.show(other);posted.length=0;
    finishOld('data:image/png;base64,b2xk');await new Promise(setImmediate);
    assert.equal(posted.length,0,'disposed old-session image completions cannot post into the new conversation');
  }finally{sidebar.dispose();}
});


test('saved-image failures retry only after connection recovery without refetching successful or pending images',async()=>{
  const received=event(),disposed=event(),visibility=event(),posted=[];
  const view={visible:true,title:'Nodecode',show(){},onDidDispose:disposed.register,onDidChangeVisibility:visibility.register,webview:{html:'',cspSource:'https://webview.local',asWebviewUri:u=>u,postMessage:m=>posted.push(m),onDidReceiveMessage:received.register}};
  const sidebar=new SessionSidebar(uri('/extension'),{}, {log(){}}),ctl=controller('image-recovery'),requests=new Map();
  let connected,available=false,finishPending;
  ctl.subscribeConnection=listener=>{connected=listener;return {dispose(){}};};
  ctl.imageDataUrl=id=>{
    requests.set(id,(requests.get(id)||0)+1);
    if(id==='pending')return new Promise(resolve=>{finishPending=resolve;});
    return id==='retry'&&!available?Promise.reject(new Error('gateway unavailable')):Promise.resolve('data:image/png;base64,aGVsbG8=');
  };
  ctl.store.applyFrame({type:'session_stream_event',session_id:ctl.sessionId,sequence:1,event:{type:'turn.input_committed',payload:{message:'Saved images',metadata:{images:['retry','success','pending'].map(id=>({id,media_type:'image/png'}))}}}});
  const images=()=>posted.at(-1).view.parts[0].images;
  try{
    sidebar.restore(ctl);sidebar.resolveWebviewView(view);await new Promise(setImmediate);
    assert.match(images()[0].error,/unavailable/);assert(images()[1].url);assert.equal(images()[2].url,undefined);
    for(let i=0;i<5;i++)ctl.store.applyFrame({type:'session_titled',title:'Streaming '+i});
    connected('connected',0);await new Promise(setImmediate);
    assert.equal(requests.get('retry'),1,'frames and duplicate connected notifications must not retry a failure');
    available=true;connected('disconnected',1);connected('connected',0);await new Promise(setImmediate);
    assert.equal(requests.get('retry'),2);assert(images()[0].url);assert.equal(images()[0].error,undefined);
    assert.equal(requests.get('success'),1);assert.equal(requests.get('pending'),1,'recovery must not replace in-flight image reads');
    connected('connected',0);connected('disconnected',1);connected('connected',0);await new Promise(setImmediate);
    assert.equal(requests.get('retry'),2,'successful recovery is cached across later reconnects');
    finishPending('data:image/png;base64,cGVuZGluZw==');await new Promise(setImmediate);
    assert.equal(images()[2].url,'data:image/png;base64,cGVuZGluZw==');assert.equal(requests.get('pending'),1);
  }finally{sidebar.dispose();}
});

test('closing a controller discards an image result already in flight',async()=>{
  let finish;
  const ctl=new SessionController({},{log(){}},{imageDataUrl:()=>new Promise(resolve=>{finish=resolve;})},'/workspace','closing-images');
  const pending=ctl.imageDataUrl('late');ctl.dispose();finish('data:image/png;base64,bGF0ZQ==');
  await assert.rejects(pending,/closed/);assert.equal(ctl.imageSources.size,0);
});

test('webview reload replaces document staging ownership without losing completed saved drafts',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nodecode-reload-files-'));
  const ctl=new SessionController({},{log(){}},{assertLocalRuntimeFiles:async()=>{}},root,'reload-reservations',root);
  const panel=Object.create(SessionPanel.prototype),posted=[];
  panel.controller=ctl;panel.attachmentSource={};panel.notes={log(){}};panel.panel={webview:{postMessage:m=>posted.push(m)}};
  panel.pendingHistory=false;panel.pendingContext=[];panel.postState=()=>{};
  try{
    await panel.onMessage({type:'ready'});const original=panel.attachmentSource;
    const complete=(await ctl.stageTextAttachmentChunk({text:'acknowledgement lost',name:'saved.txt',requestId:1,index:0,totalChunks:1},original)).attachment;
    await ctl.stageTextAttachmentChunk({text:'partial',name:'partial.txt',requestId:2,index:0,totalChunks:2},original);
    await panel.onMessage({type:'ready'});assert.notEqual(panel.attachmentSource,original);
    await assert.rejects(ctl.stageTextAttachmentChunk({text:'late',name:'partial.txt',requestId:2,index:1,totalChunks:2},original),/view closed/);
    for(let i=0;i<4;i++)await ctl.stageTextAttachmentChunk({text:'new '+i,name:'new'+i+'.txt',requestId:i+3,index:0,totalChunks:1},panel.attachmentSource);
    assert.equal(fs.readFileSync(complete.path,'utf8'),'acknowledgement lost');
    assert.equal(await ctl.openTextAttachment(complete.ref,panel.attachmentSource),complete.path);
  }finally{ctl.closeTextAttachments(panel.attachmentSource);ctl.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
