// Activation, end to end and off the real machine: a fake home whose owner
// file points at a stub gateway lets the test walk the same three gates the
// operator meets — not installed, web cell off, ready — and check what the
// view is handed at each one.

import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {createRequire,Module} from 'node:module';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'nodecode-ext-'));
process.env.NODECODE_HOME=home;
const messages=[],panels=[],status=[],providers=new Map(),commands=new Map(),executed=[],copied=[];
let pageServes=false;

class EventEmitter{constructor(){this.listeners=new Set();}event=(listener)=>{this.listeners.add(listener);return {dispose:()=>this.listeners.delete(listener)};};fire(value){for(const listener of this.listeners)listener(value);}dispose(){this.listeners.clear();}}

const disposable=()=>({dispose(){}});
const vscode={
  StatusBarAlignment:{Left:1},ProgressLocation:{Notification:15},ViewColumn:{Active:-1},
  MarkdownString:class{constructor(value){this.value=value;}},
  EventEmitter,
  Uri:{parse:(value)=>({toString:()=>value,fsPath:value}),file:(value)=>({toString:()=>value,fsPath:value})},
  env:{asExternalUri:async(uri)=>uri,openExternal:async()=>true,clipboard:{writeText:async(text)=>{copied.push(text);}}},
  workspace:{getConfiguration:()=>({get:(key)=>key==='cliPath'?'/bin/echo':undefined}),workspaceFolders:undefined},
  commands:{
    registerCommand:(id,run)=>{commands.set(id,run);return disposable();},
    executeCommand:async(id,...args)=>{executed.push(id);return commands.get(id)?.(...args);},
  },
  window:{
    createStatusBarItem:()=>{const item={show(){item.shown=true;},dispose(){}};status.push(item);return item;},
    registerWebviewViewProvider:(id,provider,options)=>{providers.set(id,{provider,options});return disposable();},
    showInformationMessage:async(message,...actions)=>{messages.push({message,actions});return undefined;},
    showWarningMessage:async()=>undefined,
    withProgress:async(_options,task)=>task(),
    createTerminal:(options)=>({options,lines:[],show(){},sendText(text){this.lines.push(text);}}),
    createWebviewPanel:(_type,title)=>{const panel={title,webview:{html:'',options:{},cspSource:'vscode-webview://test',onDidReceiveMessage(){return disposable();}},onDidDispose(){return disposable();},dispose(){}};panels.push(panel);return panel;},
  },
};

const load=Module._load;
Module._load=function(name,...args){return name==='vscode'?vscode:load.call(this,name,...args);};

const gatewayServer=http.createServer((request,response)=>{
  if(request.url==='/api/gateway/target'){response.writeHead(200,{'content-type':'application/json'});response.end('{}');return;}
  if(request.url==='/web/'&&pageServes){response.writeHead(200,{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'self'; frame-ancestors 'none'"});response.end('<html>the gateway page</html>');return;}
  response.writeHead(404,{'content-type':'text/plain'});response.end('not found');
});

const require=createRequire(import.meta.url);
const {activate}=require('../out/extension.js');
Module._load=load;

const remembered=new Map();
const context={subscriptions:[],globalState:{get:(k,fallback)=>remembered.has(k)?remembered.get(k):fallback,update:async(k,v)=>{remembered.set(k,v);}},workspaceState:{get:(_k,fallback)=>fallback,update:async()=>{}},extensionUri:vscode.Uri.file(home)};

const listening=new Promise((resolve)=>gatewayServer.listen(0,'127.0.0.1',resolve));
const settle=()=>new Promise((resolve)=>setTimeout(resolve,150));

test('activation registers the view and every command it publishes',async()=>{
  await listening;
  fs.writeFileSync(path.join(home,'history.db.owner'),JSON.stringify({pid:1,port:gatewayServer.address().port}));
  fs.writeFileSync(path.join(home,'operator-token'),'token-abc\n');
  activate(context);
  await settle();
  assert.ok(providers.get('nodecodeWeb'),'the sidebar view is registered');
  assert.equal(providers.get('nodecodeWeb').options.webviewOptions.retainContextWhenHidden,true);
  const published=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).contributes.commands.map((entry)=>entry.command);
  assert.deepEqual([...commands.keys()].sort(),published.sort(),'every contributed command exists, and none is missing');
  assert.ok(status.length>0&&status[0].shown,'the status bar item is shown');
});

test('a gateway without the web cell asks for the web cell, and says so in the view',async()=>{
  await settle();
  const ask=messages.find((entry)=>entry.message.includes('web cell is off'));
  assert.ok(ask,'the operator is asked once, by name');
  assert.ok(ask.actions.includes('Turn on the web cell'),'and offered the step that fixes it');
});

test('a window that activates again does not repeat an ask the operator already had',async()=>{
  assert.equal(remembered.get('asked.web-cell'),true,'the ask was recorded');
  pageServes=false;
  const before=messages.length;
  activate(context);
  await settle();
  assert.equal(messages.length,before,'nothing is asked twice for the same missing piece');
});

test('the view shows the setup step, then frames the page once the cell is on',async()=>{
  const view=providers.get('nodecodeWeb').provider;
  const surface={webview:{html:'',options:{},cspSource:'vscode-webview://test',onDidReceiveMessage:()=>disposable()},onDidDispose:()=>disposable()};
  view.resolveWebviewView(surface);
  await settle();
  assert.match(surface.webview.html,/data-action="enable"/,'the view offers to turn the cell on');
  assert.doesNotMatch(surface.webview.html,/<iframe/,'and frames nothing yet');

  await commands.get('nodecode.enableWebCell')();
  await settle();
  pageServes=true;
  await commands.get('nodecode.reload')();
  await settle();
  assert.match(surface.webview.html,/<iframe id="page" src="http:\/\/127\.0\.0\.1:\d+\/web\/#t=token-abc"/,'the gateway page is framed');
  assert.match(surface.webview.html,/frame-src http:\/\/127\.0\.0\.1:\d+;/,'and only that origin may be framed');
});

test('the editor tab is the same page, and the browser link is the gateway link',async()=>{
  const view=providers.get('nodecodeWeb').provider;
  await view.openInEditor();
  await settle();
  assert.equal(panels.length,1);
  assert.match(panels[0].webview.html,/<iframe/,'the editor tab frames the same page');
  await commands.get('nodecode.copyLink')();
  assert.match(copied.at(-1),/^http:\/\/127\.0\.0\.1:\d+\/web\/#t=token-abc$/);
  assert.ok(messages.some((entry)=>entry.message.includes('operator token')),'and says what it just copied');
});

test('opening the view focuses it',async()=>{
  await commands.get('nodecode.open')();
  assert.equal(executed.at(-1),'nodecodeWeb.focus');
});

after(()=>{
  for(const subscription of context.subscriptions)subscription?.dispose?.();
  gatewayServer.close();
  fs.rmSync(home,{recursive:true,force:true});
});

test('reload asks the gateway again and writes the page, even when nothing looks changed',async()=>{
  const view=providers.get('nodecodeWeb').provider;
  let writes=0,html='';
  const webview={options:{},set html(value){writes+=1;html=value;},get html(){return html;},onDidReceiveMessage:()=>disposable()};
  view.resolveWebviewView({webview,onDidDispose:()=>disposable()});
  await settle();
  const settled=writes;
  assert.ok(settled>0,'the view drew once');
  await commands.get('nodecode.reload')();
  await settle();
  assert.ok(writes>settled,'Reload writes the page the operator asked for');
  assert.match(html,/<iframe/,'and what it wrote is the page');
});
