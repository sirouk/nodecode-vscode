import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const load = Module._load;
const uri = path => ({fsPath:path,toString:()=>path});
Module._load = function(name,...args) {return name === 'vscode' ? {Uri:{file:uri,joinPath:(base,...parts)=>uri([base.fsPath,...parts].join('/'))},ViewColumn:{Active:1},commands:{executeCommand() {}}} : load.call(this,name,...args);};
const {SessionSidebar,SessionPanel} = require('../out/panel.js');
Module._load = load;
const {SessionStore} = require('../out/store.js');
function event() {const listeners=new Set();return {register:fn=>{listeners.add(fn);return {dispose:()=>listeners.delete(fn)};},fire:arg=>{for(const fn of [...listeners])fn(arg);}};}
function controller(id) {
  const store = new SessionStore();
  store.setThreads([],id);
  return {sessionId:id,store,closeTextAttachments(){},rpc:{connectionState:'connected',attempts:0},subscribeConnection:()=>({dispose(){}}),imageUrl:key=>'https://example.com/'+key};
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
  first.sendPrompt=()=>({done:new Promise(resolve=>{acknowledge=resolve;})});
  sidebar.restore(first);sidebar.resolveWebviewView(view);
  received.fire({type:'send',text:'old draft'});
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
