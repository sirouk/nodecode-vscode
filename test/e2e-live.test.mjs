// End to end, against the gateway on this machine: the extension activates,
// finds nodecode, the web cell and the gateway, and hands the view one page to
// frame. Then the test fetches exactly what the view framed — through the proxy
// the extension started — and checks the page arrives, the socket opens, the
// proxy is what made it framable, a settled poll never rewrites the page, and a
// poll never starts a process. Skips when this home has no gateway.

import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {createRequire,Module} from 'node:module';

const home=process.env.NODECODE_HOME||path.join(os.homedir(),'.nodecode');
const owner=()=>{try{return JSON.parse(fs.readFileSync(path.join(home,'history.db.owner'),'utf8'));}catch{return undefined;}};
const live=owner();
const onPath=(process.env.PATH??'').split(path.delimiter).some((dir)=>dir&&fs.existsSync(path.join(dir,'nodecode')));
const skip=!live?.port?'no gateway running in this home':!onPath?'nodecode is not on PATH here':false;

// --- a faithful enough vscode, so the real extension runs -------------------
class EventEmitter{constructor(){this.listeners=new Set();}event=(listener)=>{this.listeners.add(listener);return {dispose:()=>this.listeners.delete(listener)};};fire(value){for(const listener of this.listeners)listener(value);}dispose(){this.listeners.clear();}}
const disposable=()=>({dispose(){}});
const shown=[],panels=[],providers=new Map();
const vscode={
  StatusBarAlignment:{Left:1},ProgressLocation:{Notification:15},ViewColumn:{Active:-1},
  MarkdownString:class{constructor(value){this.value=value;}},
  EventEmitter,
  Uri:{parse:(value)=>({toString:()=>value,fsPath:value}),file:(value)=>({toString:()=>value,fsPath:value})},
  env:{asExternalUri:async(uri)=>uri,openExternal:async()=>true,clipboard:{writeText:async()=>{}}},
  workspace:{getConfiguration:()=>({get:()=>undefined}),workspaceFolders:undefined},
  commands:{registerCommand:()=>disposable(),executeCommand:async()=>undefined},
  window:{
    createStatusBarItem:()=>({show(){this.shown=true;},dispose(){}}),
    registerWebviewViewProvider:(id,provider)=>{providers.set(id,provider);return disposable();},
    createOutputChannel:()=>({appendLine(){},show(){},dispose(){}}),
    showInformationMessage:async(message)=>{shown.push(message);return undefined;},
    showWarningMessage:async(message)=>{shown.push(message);return undefined;},
    showErrorMessage:async(message)=>{shown.push(message);return undefined;},
    withProgress:async(_options,task)=>task(),
    createTerminal:()=>({show(){},sendText(){}}),
    createWebviewPanel:()=>{const panel={webview:{html:'',options:{},cspSource:'vscode-webview://e2e-panel',onDidReceiveMessage:()=>disposable()},onDidDispose:()=>disposable(),dispose(){}};panels.push(panel);return panel;},
  },
};

// Count the processes the extension starts: one read at activation, none per poll.
const childProcess=createRequire(import.meta.url)('child_process');
const realExecFileSync=childProcess.execFileSync;
let spawns=0;
childProcess.execFileSync=(...args)=>{spawns+=1;return realExecFileSync(...args);};

const load=Module._load;
Module._load=function(name,...args){return name==='vscode'?vscode:load.call(this,name,...args);};
const {activate}=createRequire(import.meta.url)('../out/extension.js');
Module._load=load;

const context={subscriptions:[],globalState:{get:(_k,fallback)=>fallback,update:async()=>{}},workspaceState:{get:(_k,fallback)=>fallback,update:async()=>{}},extensionUri:vscode.Uri.file(home)};
const settle=(ms=1200)=>new Promise((resolve)=>setTimeout(resolve,ms));

function get(url,originHeader){
  return new Promise((resolve,reject)=>{
    const request=http.request(url,{method:'GET',timeout:6000,headers:originHeader?{origin:originHeader}:{}},(response)=>{
      let body='';response.on('data',(chunk)=>{body+=chunk;});
      response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body}));
    });
    request.on('timeout',()=>{request.destroy(new Error('timeout'));});
    request.on('error',reject);
    request.end();
  });
}

function upgrade(port,origin){
  return new Promise((resolve)=>{
    const socket=net.connect(port,'127.0.0.1',()=>{
      socket.write(`GET /gateway HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`);
    });
    let buffer='';
    socket.on('data',(chunk)=>{buffer+=chunk.toString('latin1');if(buffer.includes('\r\n\r\n')){socket.destroy();resolve(buffer.split('\r\n')[0]);}});
    socket.on('error',(error)=>resolve(`error ${error.message}`));
    setTimeout(()=>{socket.destroy();resolve(`timeout`);},6000);
  });
}

let surface;
const ready=async()=>{
  if(surface) return surface;
  let writes=0,markup='';
  const webview={options:{},cspSource:'vscode-webview://e2e',onDidReceiveMessage:()=>disposable()};
  Object.defineProperty(webview,'html',{get:()=>markup,set:(value)=>{writes+=1;markup=value;}});
  const started=Date.now();
  activate(context);
  providers.get('nodecodeWeb').resolveWebviewView({webview,onDidDispose:()=>disposable()});
  let framedIn=0;
  for(let waited=0;waited<10000;waited+=50){
    if(/<iframe id="page"/.test(markup)){framedIn=Date.now()-started;break;}
    await settle(50);
  }
  surface={webview,writes:()=>writes,framedIn};
  return surface;
};

test('the extension finds this machine\'s gateway and frames its page',{skip},async(t)=>{
  const {webview}=await ready();
  const src=/<iframe id="page" src="([^"]+)"/.exec(webview.html)?.[1];
  assert.ok(src,'the view frames one page');
  assert.match(src,/^http:\/\/127\.0\.0\.1:\d+\/web\/#t=/,'framed through a loopback proxy, with the operator token');
  assert.match(webview.html,new RegExp(`frame-src ${src.split('/web/')[0].replace(/[.*+?^${}()|[\]\\]/g,'\\$&')};`),'and only that origin is frameable');
  assert.ok(surface.framedIn>0&&surface.framedIn<2500,`the page is framed quickly (${surface.framedIn}ms from activate)`);
  assert.equal(shown.length,0,'nothing is asked of an operator whose machine is ready');
  t.diagnostic(`first frame in ${surface.framedIn}ms from activate, after ${spawns} process`);
  assert.equal(spawns,1,`activation reads the version once, and nothing else (${spawns} starts)`);
});

test('what the view framed is a live page, and the socket it needs opens',{skip},async()=>{
  const {webview}=await ready();
  const src=/<iframe id="page" src="([^"]+)"/.exec(webview.html)[1];
  const proxyOrigin=new URL(src).origin;
  const proxyPort=Number(new URL(src).port);
  const page=await get(src);
  assert.equal(page.status,200,'the framed page answers');
  assert.match(String(page.headers['content-type']),/text\/html/,'as html');
  assert.ok(!String(page.headers['content-security-policy']??'').includes('frame-ancestors'),'the proxy removed the framing refusal');
  const gatewayOrigin=new URL(`http://127.0.0.1:${live.port}`).origin;
  const direct=await get(`http://127.0.0.1:${live.port}/web/`);
  assert.match(String(direct.headers['content-security-policy']),/frame-ancestors 'none'/,'while the gateway itself still refuses to be framed');
  assert.equal(await upgrade(proxyPort,proxyOrigin),'HTTP/1.1 101 Switching Protocols','the page\'s socket opens through the proxy');
  assert.equal(await upgrade(proxyPort,gatewayOrigin),'HTTP/1.1 403 Forbidden','and only from the origin the view uses');
});

test('the editor tab is the same live page',{skip},async()=>{
  const view=providers.get('nodecodeWeb');
  await view.openInEditor();
  await settle(800);
  assert.equal(panels.length,1,'one editor tab');
  const src=/<iframe id="page" src="([^"]+)"/.exec(panels[0].webview.html)?.[1];
  assert.match(String(src),/^http:\/\/127\.0\.0\.1:\d+\/web\/#t=/,'framing the same gateway page');
  const page=await get(src);
  assert.equal(page.status,200,'and that page answers');
  panels[0].dispose();
});

test('polls that find nothing new do not restart the page',{skip},async()=>{
  const {webview,writes}=await ready();
  const before=writes();
  const view=providers.get('nodecodeWeb');
  for(let tick=0;tick<5;tick+=1){await view.refresh();await settle(120);}
  assert.equal(writes(),before,'five polls wrote nothing, so the page kept its state');
  assert.equal(spawns,1,'and started no process');
});

after(()=>{
  childProcess.execFileSync=realExecFileSync;
  for(const subscription of context.subscriptions)subscription?.dispose?.();
});
