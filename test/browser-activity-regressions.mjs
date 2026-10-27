// Optional real Chromium thread regressions; use the same PLAYWRIGHT_PATH as browser-smoke.mjs.
import assert from 'node:assert/strict';
import {createRequire,Module} from 'node:module';
import fs from 'node:fs';
const require=createRequire(import.meta.url),load=Module._load;
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
Module._load=function(name,...args){return name==='vscode'?{Uri:{joinPath:()=>({toString:()=>''})}}:load.call(this,name,...args);};
const {SessionPanel}=require('../out/panel.js');Module._load=load;
const {sessionFamily}=require('../out/session-family.js');
const panel=Object.create(SessionPanel.prototype);
panel.controller={sessionId:'current'};panel.panel={webview:{cspSource:'https://webview.local'}};
panel.markUri='data:image/svg+xml;base64,'+fs.readFileSync(new URL('../media/icon.svg',import.meta.url)).toString('base64');
panel.markdownUri='https://webview.local/markdown.js';
const html=panel.html().replace(/<script nonce="([^"]+)" src="[^"]+"><\/script>/,(_,nonce)=>'<script nonce="'+nonce+'">'+fs.readFileSync(new URL('../out/markdown.js',import.meta.url),'utf8')+'</script>');
const browser=await chromium.launch({headless:true});
const emit=(page,message)=>page.evaluate(m=>window.dispatchEvent(new MessageEvent('message',{data:m})),message);
const at=hour=>'2026-10-26T'+String(hour).padStart(2,'0')+':00:00Z';
function snapshot(rows,activity=new Map()){
  return {type:'state',connection:'connected',attempts:0,history:[],view:{title:'Current',sessionId:'current',cwd:'/workspace',totals:{},parts:[],queue:[],processes:[],replayComplete:true,...sessionFamily(rows,'current',activity)}};
}
async function open(saved={threadNavigation:{open:true,idleOpen:false}}){
  const page=await browser.newPage({viewport:{width:360,height:700}});page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(saved=>{window.posted=[];window.savedState=saved;window.acquireVsCodeApi=()=>({postMessage:m=>window.posted.push(m),getState:()=>window.savedState,setState:s=>{window.savedState=structuredClone(s);}});},saved);
  await page.goto('data:text/html,'+encodeURIComponent(html));
  await page.waitForFunction(()=>window.posted.some(m=>m.type==='ready'));
  return {page,errors};
}
const ids=(page,selector)=>page.locator(selector+' [data-p]').evaluateAll(nodes=>nodes.map(node=>node.dataset.p));
const selectedVisible=()=>{
  const box=document.querySelector('#threadList').getBoundingClientRect(),row=document.querySelector('#threadList [aria-current="true"]')?.getBoundingClientRect();
  return !!row&&row.top>=box.top-1&&row.bottom<=box.bottom+1;
};
const failures=[];
async function check(name,run){try{await run();console.log('PASS '+name);}catch(error){failures.push(name);console.error('FAIL '+name+'\n'+error.stack);}}
try{
  await check('each family level retains its latest idle while native ancestors and selection stay above the fold',async()=>{
    const {page,errors}=await open();
    const rows=[{id:'root',title:'Root'},{id:'current',title:'Current',parent_id:'root'},
      {id:'new-sibling',parent_id:'root',updated_at:at(19)},{id:'old-sibling',parent_id:'root',updated_at:at(18)},
      {id:'new-child',parent_id:'current',updated_at:at(12)},{id:'nested-new',parent_id:'new-child',updated_at:at(10)},
      {id:'nested-old',parent_id:'new-child',updated_at:at(9)},{id:'older-child',parent_id:'current',updated_at:at(11)},
      {id:'running-grandchild',parent_id:'older-child'},{id:'oldest-child',parent_id:'current',updated_at:at(8)}];
    await emit(page,snapshot(rows,new Map([['running-grandchild',at(17)]])));
    assert.deepEqual(await ids(page,'#parentThreadList'),['root']);
    assert.deepEqual(await ids(page,'#activeThreadList'),['current','new-child','nested-new','older-child','running-grandchild','new-sibling']);
    assert.deepEqual(await ids(page,'#idleThreadList'),['old-sibling','oldest-child','nested-old']);
    assert.equal(await page.locator('#idleThreadDetails').evaluate(node=>node.open),false);
    for(const id of ['current','new-child','nested-new','older-child','running-grandchild','new-sibling'])assert(await page.locator('#activeThreadList [data-p="'+id+'"]').isVisible(),id+' stays outside the idle fold');
    assert.equal(await page.locator('#idleThreadList [data-p="oldest-child"]').isVisible(),false);
    const before=await page.evaluate(()=>window.posted.filter(m=>m.type==='openThread').length);
    await page.locator('[aria-current="true"]').click();
    assert.equal(await page.evaluate(()=>window.posted.filter(m=>m.type==='openThread').length),before,'current selection is a navigation no-op');
    const all=await ids(page,'#threadList');assert.equal(new Set(all).size,rows.length,'each native session renders exactly once');
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('idle recency changes remain local to their parent and preserve the idle disclosure',async()=>{
    const {page,errors}=await open();
    let rows=[{id:'root'},{id:'current',parent_id:'root'},{id:'sibling',parent_id:'root',updated_at:at(19)},
      {id:'child-a',parent_id:'current',updated_at:at(12)},{id:'child-b',parent_id:'current',updated_at:at(11)}];
    await emit(page,snapshot(rows));
    assert.deepEqual(await ids(page,'#activeThreadList'),['current','child-a','sibling']);
    assert.deepEqual(await ids(page,'#idleThreadList'),['child-b']);
    await page.locator('#idleThreadSummary').click();
    await page.waitForFunction(()=>window.savedState.threadNavigation?.idleOpen===true);
    await page.locator('#idleThreadSummary').focus();
    rows=rows.map(row=>row.id==='child-b'?{...row,updated_at:at(20)}:row);
    await emit(page,snapshot(rows));
    assert.deepEqual(await ids(page,'#activeThreadList'),['current','child-b','sibling']);
    assert.deepEqual(await ids(page,'#idleThreadList'),['child-a']);
    assert(await page.locator('#idleThreadDetails').evaluate(node=>node.open));
    assert.equal(await page.evaluate(()=>document.activeElement.id),'idleThreadSummary');
    const restored=await open(await page.evaluate(()=>window.savedState));await emit(restored.page,snapshot(rows));
    assert(await restored.page.locator('#idleThreadDetails').evaluate(node=>node.open),'idle disclosure survives recreation');
    assert.deepEqual(restored.errors,[]);await restored.page.close();
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('explicit same-webview navigation reveals a deep selection without live-update scroll jumps',async()=>{
    const rows=Array.from({length:15},(_,i)=>({id:i===14?'current':'ancestor-'+i,title:'Level '+i,...(i?{parent_id:'ancestor-'+(i-1)}:{})}));
    for(const initiallyOpen of [true,false]){
      const {page,errors}=await open({threadNavigation:{open:initiallyOpen,idleOpen:false}});
      await emit(page,snapshot(rows));
      if(!initiallyOpen)await page.locator('#threadDetails > summary').click();
      await page.waitForFunction(selectedVisible);
      for(const collapse of [false,true]){
        await page.locator('#threadList').evaluate(node=>{node.scrollTop=0;});
        await emit(page,snapshot(rows.map(row=>row.id==='current'?{...row,title:'Updated '+collapse}:row)));
        assert.equal(await page.locator('#threadList').evaluate(node=>node.scrollTop),0,'live updates respect deliberate scrolling');
        if(collapse)await page.locator('#threadDetails > summary').click();
        await emit(page,{type:'threadNavigationRestore',state:{open:true,idleOpen:false}});
        await page.waitForFunction(selectedVisible);
        assert(await page.locator('#threadList').evaluate(node=>node.scrollTop)>0,'navigation reveals the current thread');
        await page.locator('#threadList').evaluate(node=>{node.scrollTop=0;});
        await emit(page,snapshot(rows));
        assert.equal(await page.locator('#threadList').evaluate(node=>node.scrollTop),0,'later live updates do not re-reveal');
      }
      assert.deepEqual(errors,[]);await page.close();
    }
  });
  await check('navigation restored before the first family state reveals selection when it arrives',async()=>{
    const {page,errors}=await open({threadNavigation:{open:false,idleOpen:true}});
    await emit(page,{type:'threadNavigationRestore',state:{open:true,idleOpen:false}});
    const rows=Array.from({length:15},(_,i)=>({id:i===14?'current':'ancestor-'+i,...(i?{parent_id:'ancestor-'+(i-1)}:{})}));
    await emit(page,snapshot(rows));await page.waitForFunction(selectedVisible);
    assert.equal(await page.locator('#idleThreadDetails').evaluate(node=>node.open),false);
    assert.deepEqual(errors,[]);await page.close();
  });
  assert.deepEqual(failures,[],'Chromium activity regressions failed');
}finally{await browser.close();}
