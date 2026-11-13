import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,Module} from 'node:module';
const require=createRequire(import.meta.url),load=Module._load;
class EventEmitter{event=()=>({dispose(){}});fire(){}dispose(){}}
const vscode={EventEmitter,window:{createWebviewPanel(){}},ViewColumn:{Active:-1},env:{openExternal:async()=>true,asExternalUri:async(uri)=>uri},Uri:{parse:(value)=>({toString:()=>value})}};
Module._load=function(name,...args){return name==='vscode'?vscode:load.call(this,name,...args);};
const {renderHtml,escapeHtml}=require('../out/view.js');
Module._load=load;

const status=(overrides={})=>({state:'ready',message:'Nodecode is ready.',version:'0.1.14',binary:'/usr/bin/nodecode',installCommand:'curl -fsSL https://nodecode.ai/install.sh | sh',installUrl:'https://nodecode.ai/install.sh',docsUrl:'https://nodecode.ai/docs',baseUrl:'http://127.0.0.1:50171',...overrides});
const render=(options)=>renderHtml({status:status(),nonce:'abc123',cspSource:'x',...options});

test('the ready view frames the gateway page and allows exactly that origin',()=>{
  const html=render({frame:{url:'http://127.0.0.1:53117/web/#t=secret',origin:'http://127.0.0.1:53117'}});
  assert.match(html,/frame-src http:\/\/127\.0\.0\.1:53117;/);
  assert.match(html,/<iframe id="page" src="http:\/\/127\.0\.0\.1:53117\/web\/#t=secret"/);
  assert.match(html,/allow="clipboard-read; clipboard-write"/);
  assert.doesNotMatch(html,/class="action/,'the ready view offers no setup steps');
  assert.match(html,/script-src 'nonce-abc123'/);
});

test('each missing piece names one step and never leaks the token',()=>{
  const cases=[
    ['missing-cli',"Nodecode is not installed, or not on this machine's PATH."],
    ['web-cell-off','The gateway is running at http://127.0.0.1:50171 without the web cell'],
    ['gateway-down','The Nodecode gateway is not running in this home.'],
  ];
  for(const [state,message] of cases){
    const html=render({status:status({state,message})});
    assert.ok(html.includes(escapeHtml(message)),`${state} shows its message`);
    assert.doesNotMatch(html,/http:\/\/127\.0\.0\.1:\d+\/web\/#t=/,`${state} frames nothing`);
    assert.match(html,/data-action="recheck"/);
  }
  assert.match(render({status:status({state:'missing-cli',message:'x'})}),/data-action="install"/);
  assert.match(render({status:status({state:'gateway-down',message:'x'})}),/data-action="start"/);
  assert.match(render({status:status({state:'web-cell-off',message:'x'})}),/data-action="enable"/);
  assert.doesNotMatch(render({status:status({state:'web-cell-off',message:'x'})}),/data-action="install"/);
});

test('messages from the gateway are written as text, never as markup',()=>{
  const html=render({status:status({state:'gateway-down',message:'<img src=x onerror="boom">'})});
  assert.doesNotMatch(html,/<img src=x/);
  assert.match(html,/&lt;img src=x onerror=&quot;boom&quot;&gt;/);
  assert.equal(escapeHtml(`<&>"'`),'&lt;&amp;&gt;&quot;&#39;');
});

test('work in progress says so and offers nothing to press',()=>{
  const html=render({working:'Turning the web cell on…'});
  assert.match(html,/Turning the web cell on…/);
  assert.doesNotMatch(html,/data-action="/);
  assert.doesNotMatch(html,/<iframe/);
});

test('a poll that finds nothing new leaves the framed page alone',async()=>{
  const {NodecodeView}=require('../out/view.js');
  let writes=0,html='';
  const webview={cspSource:'x',options:{},set html(value){writes++;html=value;},get html(){return html;},onDidReceiveMessage(){}};
  let state={state:'ready',message:'Nodecode is ready.',version:'0.1.14',installCommand:'x',installUrl:'y',docsUrl:'z',baseUrl:'http://127.0.0.1:50171'};
  const page='http://127.0.0.1:53117/web/#t=secret';
  let link=page;
  const gateway={frame:async()=>link?{status:state,pageUrl:link,pageOrigin:'http://127.0.0.1:53117'}:{status:state},status:async()=>state,startGateway:async()=>state,enableWebCell:async()=>state,notify(){}};
  const view=new NodecodeView(gateway,{log(){}},{install(){}});
  view.resolveWebviewView({webview,onDidDispose:(fn)=>fn&&0});
  await new Promise((resolve)=>setTimeout(resolve,20));
  assert.equal(writes,1,'the page is written once');
  assert.match(html,/<iframe id="page" src="http:\/\/127\.0\.0\.1:53117\/web\/#t=secret"/);
  for(let tick=0;tick<4;tick+=1) await view.refresh();
  assert.equal(writes,1,'four polls that changed nothing rewrite nothing, so the page keeps its state');
  state={...state,state:'gateway-down',message:'The gateway stopped answering.'};
  link=undefined;
  await view.refresh();
  assert.equal(writes,2,'a real change is written');
  assert.doesNotMatch(html,/<iframe/,'the page is gone, so it is not framed');
  view.dispose();
});

test('the editor tab is opened once, and pressing again reveals it',async()=>{
  const {NodecodeView}=require('../out/view.js');
  const made=[];
  vscode.window.createWebviewPanel=()=>{
    const panel={revealed:0,disposed:false,webview:{html:'',options:{},onDidReceiveMessage:()=>({dispose(){}})},onDidDispose:()=>undefined,reveal(){this.revealed+=1;},dispose(){this.disposed=true;}};
    made.push(panel);
    return panel;
  };
  const state={state:'ready',message:'Nodecode is ready.',version:'0.1.14',installCommand:'x',docsUrl:'z'};
  const page={status:state,pageUrl:'http://127.0.0.1:53117/web/#t=tok',pageOrigin:'http://127.0.0.1:53117'};
  const gateway={frame:async()=>page,status:async()=>state,startGateway:async()=>state,enableWebCell:async()=>state};
  const view=new NodecodeView(gateway,{log(){}},{install(){}});
  try{
    await view.openInEditor();
    await view.openInEditor();
    assert.equal(made.length,1,'a second press does not open a second tab');
    assert.equal(made[0].revealed,1,'it brings the tab that exists to the front');
    assert.match(made[0].webview.html,/<iframe/,'and that tab is the page');
  }finally{view.dispose();}
});

test('a view that went away mid-write is logged, never thrown',async()=>{
  const {NodecodeView}=require('../out/view.js');
  const logged=[];
  const webview={options:{},onDidReceiveMessage:()=>({dispose(){}}),set html(_value){throw new Error('Webview is disposed');},get html(){return '';}};
  const state={state:'gateway-down',message:'nothing yet',version:'unknown',installCommand:'x',docsUrl:'z'};
  const gateway={frame:async()=>({status:state}),status:async()=>state,startGateway:async()=>state,enableWebCell:async()=>state};
  const view=new NodecodeView(gateway,{log:(line)=>logged.push(line)},{install(){}});
  try{
    view.resolveWebviewView({webview,onDidDispose:()=>undefined});
    await view.refresh();
    assert.ok(logged.some((line)=>line.includes('Webview is disposed')),'the reason is in the output channel');
  }finally{view.dispose();}
});

test('reload writes the page again even when nothing changed, and a plain poll does not',async()=>{
  const {NodecodeView}=require('../out/view.js');
  let writes=0,html='';
  const webview={options:{},set html(value){writes+=1;html=value;},get html(){return html;},onDidReceiveMessage:()=>({dispose(){}})};
  let revision=1;
  const state={state:'ready',message:'Nodecode is ready.',version:'0.1.14',installCommand:'x',docsUrl:'z'};
  const gateway={frame:async()=>({status:state,pageUrl:'http://127.0.0.1:53117/web/#t=tok',pageOrigin:'http://127.0.0.1:53117',revision}),status:async()=>state,startGateway:async()=>state,enableWebCell:async()=>state};
  const view=new NodecodeView(gateway,{log(){}},{install(){}});
  try{
    view.resolveWebviewView({webview,onDidDispose:()=>undefined});
    await view.refresh();
    assert.equal(writes,1);
    await view.refresh();
    assert.equal(writes,1,'a poll that found nothing new still writes nothing');
    await view.refresh(true);
    assert.equal(writes,2,'Reload reloads the page the operator asked it to reload');
    revision=2;
    await view.refresh();
    assert.equal(writes,3,'a gateway that restarted is framed afresh, even at the same address');
  }finally{view.dispose();}
});
