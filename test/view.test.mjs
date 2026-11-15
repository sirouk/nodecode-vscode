import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,Module} from 'node:module';
const require=createRequire(import.meta.url),load=Module._load;
class EventEmitter{event=()=>({dispose(){}});fire(){}dispose(){}}
const vscode={EventEmitter,window:{createWebviewPanel(){}},ViewColumn:{Active:-1},env:{openExternal:async()=>true,asExternalUri:async(uri)=>uri},Uri:{parse:(value)=>({toString:()=>value})}};
Module._load=function(name,...args){return name==='vscode'?vscode:load.call(this,name,...args);};
const {renderHtml,escapeHtml}=require('../out/view.js');
Module._load=load;

const status=(overrides={})=>({state:'ready',message:'Nodecode is ready.',version:'0.1.14',binary:'/usr/bin/nodecode',docsUrl:'https://nodecode.ai/docs',baseUrl:'http://127.0.0.1:50171',...overrides});
const render=(options)=>renderHtml({status:status(),nonce:'abc123',cspSource:'x',...options});

test('the ready view frames the gateway page and allows exactly that origin',()=>{
  const html=render({frame:{url:'http://127.0.0.1:53117/web/#t=secret',origin:'http://127.0.0.1:53117'}});
  assert.match(html,/frame-src http:\/\/127\.0\.0\.1:53117 http:\/\/127\.0\.0\.1:\*;/,'the framed page, and the loopback forward a machine switch lands on');
  assert.match(html,/<iframe id="page" src="http:\/\/127\.0\.0\.1:53117\/web\/#t=secret"/);
  assert.match(html,/allow="clipboard-read; clipboard-write"/);
  assert.doesNotMatch(html,/class="action/,'the ready view offers no setup steps');
  assert.match(html,/script-src 'nonce-abc123'/);
});

test('the framed page is given the host half of the clipboard bridge, bound to its own origin',()=>{
  const html=render({frame:{url:'http://127.0.0.1:53117/web/#t=secret',origin:'http://127.0.0.1:53117'}});
  assert.match(html,/nodecode !== "frame"/,'the host answers the page, and only the page');
  assert.match(html,/event\.source !== page\.contentWindow/,'a message from another window is not the page');
  assert.match(html,/event\.origin !== origin/,'nor is one posted from another origin');
  assert.match(html,/const origin = "http:\/\/127\.0\.0\.1:53117"/,'bound to the framed origin, not to any origin');
  assert.match(html,/clipboard\.read\(\)/,'the read the page cannot do itself');
  assert.match(html,/clipboard\.writeText\(/,'and the write its copy buttons need');
});

test('a setup page carries no bridge: there is no page to bridge to',()=>{
  const html=render({});
  assert.doesNotMatch(html,/nodecode !== "frame"/);
  assert.doesNotMatch(html,/nodecode-bridge/);
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
  assert.doesNotMatch(render({status:status({state:'missing-cli',message:'x'})}),/data-action="install"/,'a missing nodecode is never installed from here');
  assert.match(render({status:status({state:'missing-cli',message:'x'})}),/href="https:\/\/nodecode\.ai\/docs"/,'the docs are where it comes from');
  assert.match(render({status:status({state:'gateway-down',message:'x'})}),/data-action="start"/);
  assert.match(render({status:status({state:'web-cell-off',message:'x',webCellInstalled:true})}),/data-action="enable"/,'a cell this machine has is loaded from here');
  assert.doesNotMatch(render({status:status({state:'web-cell-off',message:'x',webCellInstalled:false})}),/data-action="enable"/,'a cell this home lacks is never promised');
  assert.match(render({status:status({state:'web-cell-off',message:'x',webCellInstalled:false})}),/\/cells/,'and the page says where to turn it on');
  assert.doesNotMatch(render({status:status({state:'web-cell-off',message:'x'})}),/data-action="install"/);
});

test('the tailnet panel is as tall as the view allows, not a percentage of the mark it hangs from',()=>{
  const html=render({frame:{url:'http://127.0.0.1:53117/web/#t=secret',origin:'http://127.0.0.1:53117'}});
  const rule=html.match(/#tailnet-panel \{[^}]*\}/)?.[0]??'';
  assert.match(rule,/max-height: calc\(100vh - \d+px\)/,'its wrapper is one line tall, so a percentage clipped every row');
  assert.match(rule,/width: min\(\d+px, calc\(100vw - \d+px\)\)/,'and a sidebar narrower than the panel does not push its left side off screen');
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
  let state={state:'ready',message:'Nodecode is ready.',version:'0.1.14',docsUrl:'z',baseUrl:'http://127.0.0.1:50171'};
  const page='http://127.0.0.1:53117/web/#t=secret';
  let link=page;
  const gateway={frame:async()=>link?{status:state,pageUrl:link,pageOrigin:'http://127.0.0.1:53117'}:{status:state},status:async()=>state,startGateway:async()=>state,reloadWebCell:async()=>state,notify(){}};
  const view=new NodecodeView(gateway,{log(){}});
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
  const state={state:'ready',message:'Nodecode is ready.',version:'0.1.14',docsUrl:'z'};
  const page={status:state,pageUrl:'http://127.0.0.1:53117/web/#t=tok',pageOrigin:'http://127.0.0.1:53117'};
  const gateway={frame:async()=>page,status:async()=>state,startGateway:async()=>state,reloadWebCell:async()=>state};
  const view=new NodecodeView(gateway,{log(){}});
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
  const state={state:'gateway-down',message:'nothing yet',version:'unknown',docsUrl:'z'};
  const gateway={frame:async()=>({status:state}),status:async()=>state,startGateway:async()=>state,reloadWebCell:async()=>state};
  const view=new NodecodeView(gateway,{log:(line)=>logged.push(line)});
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
  const state={state:'ready',message:'Nodecode is ready.',version:'0.1.14',docsUrl:'z'};
  const gateway={frame:async()=>({status:state,pageUrl:'http://127.0.0.1:53117/web/#t=tok',pageOrigin:'http://127.0.0.1:53117',revision}),status:async()=>state,startGateway:async()=>state,reloadWebCell:async()=>state};
  const view=new NodecodeView(gateway,{log(){}});
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

test('a machine that cannot be framed keeps the page and says why; one that can is shown, and this one is the way back',async()=>{
  const {NodecodeView}=require('../out/view.js');
  let html='',writes=0;const posted=[];let handler;
  const webview={options:{},set html(value){writes+=1;html=value;},get html(){return html;},onDidReceiveMessage:(fn)=>{handler=fn;return {dispose(){}};},postMessage:async(message)=>{posted.push(message);return true;}};
  const state={state:'ready',message:'Nodecode is ready.',version:'0.1.14',docsUrl:'z'};
  const peer='https://peer.tail.ts.net:8434';
  const asked=[];
  const gateway={
    frame:async()=>({status:state,pageUrl:'http://127.0.0.1:53117/web/#t=home',pageOrigin:'http://127.0.0.1:53117'}),
    frameFor:async(target)=>{asked.push(target);return target===peer?{status:state,pageUrl:'http://127.0.0.1:53999/web/',pageOrigin:'http://127.0.0.1:53999'}:{status:state,refused:'gone.tail.ts.net did not answer as Nodecode.'};},
    status:async()=>state,startGateway:async()=>state,reloadWebCell:async()=>state,
  };
  const tailnet={state:async()=>({state:{available:true}}),act:async()=>({}),install:async()=>({})};
  const view=new NodecodeView(gateway,{log(){}},tailnet);
  const settle=()=>new Promise((resolve)=>setTimeout(resolve,20));
  try{
    view.resolveWebviewView({webview,onDidDispose:()=>undefined});
    await settle();
    assert.match(html,/53117\/web\/#t=home/);
    const before=writes;
    handler({type:'tailnet-switch',url:'https://gone.tail.ts.net:8434'});
    await settle();
    assert.equal(writes,before,'a refused switch leaves the page as it was');
    assert.match(posted.at(-1).view.switchRefused,/did not answer as Nodecode/,'and the panel says why');
    handler({type:'tailnet-switch',url:peer});
    await settle();
    assert.match(html,/53999\/web\//,'a peer that answers is the page from now on');
    await view.refresh();
    assert.equal(asked.at(-1),peer,'and a poll keeps it there');
    handler({type:'tailnet'});
    await settle();
    assert.equal(posted.at(-1).view.showing,peer,'the panel knows which machine it shows');
    handler({type:'tailnet-switch',url:''});
    await settle();
    assert.match(html,/53117\/web\/#t=home/,'switching to this machine comes home');
  }finally{view.dispose();}
});

// The panel's own script, run against just enough of a document to hold it:
// elements with ids, classes, children and data attributes, and the window's
// message, click, key and blur events.
function panelUnderTest(){
  const {tailnetScript}=require('../out/view.js');
  const byId={},listeners={},sent=[];
  const node=(tag,id)=>{
    const n={tagName:tag,id:id||'',className:'',textContent:'',hidden:false,children:[],dataset:{},style:{},parent:null,listeners:{},
      append(...kids){for(const kid of kids){kid.parent=n;n.children.push(kid);if(kid.id)byId[kid.id]=kid;}},
      replaceChildren(){n.children=[];},
      addEventListener(type,fn){n.listeners[type]=fn;},
      querySelector(sel){return n.children.find((kid)=>kid.className.split(' ').includes(sel.slice(1)))||null;},
      closest(sel){for(let at=n;at;at=at.parent){if(sel.startsWith('#')?at.id===sel.slice(1):at.dataset[sel.slice(6,-1)]!==undefined)return at;}return null;},
      get classList(){return {toggle:(name,on)=>{n.className=on?(n.className+' '+name).trim():n.className.split(' ').filter((c)=>c!==name).join(' ');},remove:(name)=>{n.className=n.className.split(' ').filter((c)=>c!==name).join(' ');}};},
    };
    return n;
  };
  const root=node('div','tailnet'),mark=node('button','tailnet-mark'),dot=node('span'),panel=node('div','tailnet-panel'),body=node('div','tailnet-body'),page=node('iframe','page');
  dot.className='dot';mark.append(dot);panel.append(body);root.append(mark,panel);byId.page=page;panel.hidden=true;
  const document={activeElement:null,getElementById:(id)=>byId[id]||null,createElement:(tag)=>node(tag),addEventListener:(type,fn)=>{listeners['doc:'+type]=fn;}};
  const window={addEventListener:(type,fn)=>{listeners['win:'+type]=fn;}};
  const timers=[];
  new Function('document','window','api','setTimeout',tailnetScript())(document,window,{postMessage:(m)=>sent.push(m)},(fn)=>timers.push(fn));
  const text=(n)=>n.textContent+n.children.map(text).join(' ');
  const find=(n,pred)=>pred(n)?n:n.children.reduce((hit,kid)=>hit||find(kid,pred),null);
  return {
    sent,dot,panel,document,page,
    say:(view)=>listeners['win:message']({data:{type:'tailnet-state',view}}),
    open:()=>mark.listeners.click(),
    clickOutside:()=>listeners['doc:click']({target:node('div')}),
    blurTo:(element)=>{document.activeElement=element;listeners['win:blur']();timers.splice(0).forEach((fn)=>fn());},
    text:()=>text(body),
    rows:()=>body.children.filter((row)=>row.className==='row'&&row.children.some((kid)=>kid.className.startsWith('mdot'))).map((row)=>({mark:row.children[0].className,label:row.children[1].textContent})),
    find:(pred)=>find(body,pred),
  };
}

const here={name:'console',host:'console.tail.ts.net',address:'https://console.tail.ts.net:8434/web/',current:true,paired:false};
const peer={name:'trader',host:'trader.tail.ts.net',address:'https://trader.tail.ts.net:8434/web/',current:false,paired:false};

test('the page asks for the panel state as it loads, so the pill is marked before the panel is opened',()=>{
  const panel=panelUnderTest();
  assert.deepEqual(panel.sent,[{type:'tailnet'}]);
});

test('the pill is green on this machine, blue on another, and blue even when this machine is not serving',()=>{
  const panel=panelUnderTest();
  panel.say({state:{available:true,running:true,machines:[here,peer]},showing:''});
  assert.equal(panel.dot.className,'dot local');
  panel.say({state:{available:true,running:true,machines:[here,peer]},showing:'https://trader.tail.ts.net:8434/web/'});
  assert.equal(panel.dot.className,'dot remote');
  panel.say({state:{available:true,running:false,machines:[{...here,address:undefined},peer]},showing:'https://trader.tail.ts.net:8434/web/'});
  assert.equal(panel.dot.className,'dot remote','the page is still another machine\'s');
  panel.say({state:{available:true,running:false,machines:[{...here,address:undefined}]},showing:''});
  assert.equal(panel.dot.className,'dot','this machine, not serving: unlit');
});

test('the list marks where we are, what is paired, and what is not',()=>{
  const panel=panelUnderTest();
  const third={name:'laptop',host:'laptop.tail.ts.net',address:'https://laptop.tail.ts.net:8434/web/',current:false,paired:false};
  panel.say({state:{available:true,running:true,machines:[here,{...peer,paired:true},third]},showing:''});
  assert.deepEqual(panel.rows(),[
    {mark:'mdot here local',label:'console (this one) \u00b7 showing'},
    {mark:'mdot paired',label:'trader'},
    {mark:'mdot',label:'laptop'},
  ]);
  panel.say({state:{available:true,running:true,machines:[here,{...peer,paired:true},third]},showing:'https://trader.tail.ts.net:8434'});
  assert.deepEqual(panel.rows().slice(0,2),[
    {mark:'mdot',label:'console (this one)'},
    {mark:'mdot here remote',label:'trader \u00b7 showing'},
  ],'a machine just paired is shown at its base address, and still marked as where we are');
});

test('a page from another machine keeps the way back even when this machine is the only other one listed',()=>{
  const panel=panelUnderTest();
  panel.say({state:{available:true,running:false,machines:[{...here,address:undefined}]},showing:'https://trader.tail.ts.net:8434/web/'});
  const back=panel.find((n)=>n.dataset.tn==='switch');
  assert.ok(back,'a Switch back to this machine is offered');
  assert.equal(back.dataset.url,'','and it means this machine');
});

test('the panel closes on a click outside it and on focus leaving, but not while it waits for a code from elsewhere',()=>{
  const panel=panelUnderTest();
  const state={available:true,running:true,machines:[here,peer]};
  panel.open();panel.say({state,showing:''});
  assert.equal(panel.panel.hidden,false);
  panel.clickOutside();
  assert.equal(panel.panel.hidden,true,'a click outside closes it');
  panel.open();
  panel.blurTo(panel.document.body);
  assert.equal(panel.panel.hidden,true,'focus going elsewhere closes it');
  panel.open();panel.say({state,showing:'',needsCode:'https://trader.tail.ts.net:8434'});
  panel.blurTo(null);
  assert.equal(panel.panel.hidden,false,'gone to read the code: the field stays up');
  panel.blurTo(panel.page);
  assert.equal(panel.panel.hidden,true,'a click into the page still closes it');
});

test('the editor tab hands the host the whole message, as the sidebar does',async()=>{
  const {NodecodeView}=require('../out/view.js');
  let handler;
  vscode.window.createWebviewPanel=()=>({webview:{html:'',options:{},onDidReceiveMessage:(fn)=>{handler=fn;return {dispose(){}};},postMessage:async()=>true},onDidDispose:()=>undefined,reveal(){},dispose(){}});
  const state={state:'ready',message:'Nodecode is ready.',version:'0.1.14',docsUrl:'z'};
  const gateway={frame:async()=>({status:state,pageUrl:'http://127.0.0.1:53117/web/',pageOrigin:'http://127.0.0.1:53117'}),status:async()=>state};
  const acted=[];
  const tailnet={state:async()=>({state:{available:true}}),act:async(body)=>{acted.push(body);return {state:{available:true}};},install:async()=>({})};
  const view=new NodecodeView(gateway,{log(){}},tailnet);
  try{
    await view.openInEditor();
    handler({type:'tailnet-act',action:'forget',index:2});
    await new Promise((resolve)=>setTimeout(resolve,20));
    assert.deepEqual(acted,[{action:'forget',index:2}]);
  }finally{view.dispose();}
});
