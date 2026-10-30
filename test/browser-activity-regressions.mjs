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
  await check('omitted recorded files bypass serialization and retain their DOM across streaming and action receipts',async()=>{
    const {page,errors}=await open();
    const state=snapshot([]),patch='@@ -1,80 +1,80 @@\n'+Array.from({length:80},(_,i)=>' '+i+' '+('recorded source '.repeat(16))).join('\n');
    state.view.modifiedFiles=Array.from({length:100},(_,i)=>({path:'src/file-'+i+'.ts',added:1,removed:1,patch,changeCount:1}));
    state.view.parts=[{kind:'assistant',text:'',reasoning:'Streaming thought',streaming:true}];
    await emit(page,state);await page.locator('#fileSummary').click();await page.waitForTimeout(30);
    const result=await page.evaluate(state=>{
      const list=document.querySelector('#fileList'),nodes=Array.from(list.querySelectorAll(':scope > [data-file-path]')),button=nodes[5].querySelector('.diff-open');
      list.scrollTop=80;button.focus({preventScroll:true});const top=list.scrollTop;
      let serializations=0,characters=0;
      const stringify=JSON.stringify,observer=new MutationObserver(()=>{});
      JSON.stringify=function(value,...args){const text=Reflect.apply(stringify,this,[value,...args]);if(Array.isArray(value)&&value.length===100&&value[0]?.path==='src/file-0.ts'){serializations++;characters+=text.length;}return text;};
      observer.observe(document.querySelector('#fileBar'),{subtree:true,childList:true,characterData:true,attributes:true});
      const next=structuredClone(state);delete next.view.modifiedFiles;next.view.modifiedFilesOmitted=true;
      const start=performance.now();
      try{
        for(let i=0;i<30;i++){const message=structuredClone(next);message.view.parts[0].reasoning+=' '+i;window.dispatchEvent(new MessageEvent('message',{data:message}));}
        window.dispatchEvent(new MessageEvent('message',{data:{type:'bookmarkFinished',turnId:'completed',ids:['completed']}}));
        window.dispatchEvent(new MessageEvent('message',{data:{type:'forkFinished',turnId:'completed'}}));
        return {serializations,characters,elapsedMs:performance.now()-start,mutations:observer.takeRecords().length,count:nodes.length,sameNodes:nodes.every((node,i)=>node===list.children[i]),sameFocus:document.activeElement===button,top,listTop:list.scrollTop};
      }finally{JSON.stringify=stringify;observer.disconnect();}
    },state);
    console.log('Recorded-file omitted ticks: '+JSON.stringify(result));
    assert.equal(result.serializations,0,'unchanged omitted files must not be serialized again');
    assert.equal(result.characters,0);assert.equal(result.mutations,0,'unchanged files do not recompute headings or touch rows');
    assert.equal(result.count,100);assert(result.sameNodes);assert(result.sameFocus);assert.equal(result.listTop,result.top);
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('selected recorded-file updates apply after clearing selection on an omitted tick',async()=>{
    const {page,errors}=await open();await page.setViewportSize({width:760,height:920});
    const state=snapshot([]),patch='@@ -1,100 +1,100 @@\n'+Array.from({length:100},(_,i)=>' '+i+' '+('long recorded source '.repeat(18))).join('\n');
    state.view.modifiedFiles=[{path:'src/selected.ts',added:1,removed:1,patch,changeCount:1}];
    await emit(page,state);await page.locator('#fileSummary').click();await page.locator('#fileList .diff-summary').click();
    await page.waitForFunction(()=>!document.querySelector('#fileList .diff-code').hasAttribute('data-diff-pending'));
    const pane=page.locator('#fileList .diff-code');
    const position=await pane.evaluate(node=>{node.scrollTop=150;node.scrollLeft=200;node.focus();return [node.scrollTop,node.scrollLeft];});
    assert(position[0]>0&&position[1]>0);
    const selected=await pane.evaluate(node=>{window.selectedActivityPane=node;const range=document.createRange();range.selectNodeContents(node.querySelectorAll('.diff-source')[4]);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return selection.toString();});
    const changed={...state,view:{...state.view,modifiedFiles:[{...state.view.modifiedFiles[0],added:2,patch:patch.replace('0 long recorded','0 CHANGED recorded'),changeCount:2}]}};
    await emit(page,changed);
    const omitted={...changed,view:{...changed.view,modifiedFilesOmitted:true}};delete omitted.view.modifiedFiles;
    await emit(page,omitted);
    assert.equal(await page.evaluate(()=>getSelection().toString()),selected);assert(await pane.evaluate(node=>node===window.selectedActivityPane));
    assert.equal((await pane.textContent()).includes('CHANGED recorded'),false,'a selection keeps its original recorded patch');
    await page.evaluate(message=>{getSelection().removeAllRanges();window.dispatchEvent(new MessageEvent('message',{data:message}));},omitted);
    await page.waitForFunction(()=>document.querySelector('#fileList .diff-code').textContent.includes('CHANGED recorded'));
    assert.equal(await page.locator('#fileList .diff-summary').getAttribute('aria-expanded'),'true');
    assert.equal(await page.locator('#fileList .diff-note').textContent(),'Latest recorded change · 2 change receipts');
    assert((await page.locator('#fileSummary').textContent()).includes('+2'));
    assert.deepEqual(await pane.evaluate(node=>[node.scrollTop,node.scrollLeft]),position);assert(await pane.evaluate(node=>document.activeElement===node));
    await emit(page,{...changed,view:{...changed.view,modifiedFiles:[{...changed.view.modifiedFiles[0],patch:changed.view.modifiedFiles[0].patch.replace('CHANGED recorded','LATEST recorded')}]}});
    assert((await pane.textContent()).includes('LATEST recorded'),'a later full collection with changed patch text still updates');
    const empty={...state,view:{...state.view,modifiedFiles:[]}};await emit(page,empty);
    assert.equal(await page.locator('#fileList > [data-file-path]').count(),0);assert.equal(await page.locator('#fileBar').isVisible(),false);
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('streaming leaves unchanged process history untouched, expanded or collapsed',async()=>{
    const {page,errors}=await open();
    const state=snapshot([]);
    state.view.processes=Array.from({length:191},(_,i)=>({id:String(i),execId:i,command:'Recorded command '+i,status:i<182?'exited':'unknown',exitCode:i<182?0:undefined,output:('Retained output '+i+'\n').repeat(60)}));
    state.view.parts=[{kind:'assistant',text:'',reasoning:'Streaming thought',streaming:true}];
    await emit(page,state);
    for(const expanded of [false,true]){
      await page.locator('#processDetails').evaluate((node,expanded)=>{node.open=expanded;node.querySelectorAll('.activity-process').forEach(row=>{row.open=expanded;});},expanded);
      await page.waitForTimeout(30);
      const result=await page.evaluate(state=>{
        const list=document.querySelector('#processList'),nodes=Array.from(list.children),output=nodes.map(node=>node.querySelector('pre').textContent);
        let layoutReads=0;
        const height=Object.getOwnPropertyDescriptor(Element.prototype,'clientHeight');
        nodes.forEach(node=>Object.defineProperty(node.querySelector('pre'),'clientHeight',{configurable:true,get(){layoutReads++;return height.get.call(this);}}));
        const observer=new MutationObserver(()=>{});observer.observe(document.querySelector('#procBar'),{subtree:true,childList:true,characterData:true,attributes:true});
        const start=performance.now();
        for(let i=0;i<30;i++){
          const next=structuredClone(state);next.view.parts[0].reasoning+=' '+i;
          window.dispatchEvent(new MessageEvent('message',{data:next}));
        }
        const elapsedMs=performance.now()-start,mutations=observer.takeRecords().length;observer.disconnect();
        return {layoutReads,mutations,elapsedMs,count:list.children.length,sameNodes:nodes.every((node,i)=>node===list.children[i]),sameOutput:nodes.every((node,i)=>node.querySelector('pre').textContent===output[i])};
      },state);
      assert.equal(result.count,191);assert(result.sameNodes);assert(result.sameOutput);
      assert.equal(result.mutations,0,'token updates must not rewrite unchanged process history');
      assert.equal(result.layoutReads,0,'token updates must not measure unchanged process output panes');
    }
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('unchanged process output follows reflow without disturbing deliberate reading',async()=>{
    const {page,errors}=await open();await page.setViewportSize({width:800,height:700});
    const state=snapshot([]);
    state.view.processes=[{id:'resize',execId:8,command:'Long output',status:'running',output:('A long output line that wraps in the narrow pane. '.repeat(2)+'\n').repeat(100)}];
    await emit(page,state);
    await page.locator('#processDetails > summary').click();await page.locator('.activity-process > summary').click();
    const pane=page.locator('.process-output');
    await pane.evaluate(node=>{node.scrollTop=node.scrollHeight;});await page.waitForTimeout(30);
    await page.setViewportSize({width:360,height:700});
    await page.waitForTimeout(100);
    assert(await pane.evaluate(node=>node.scrollHeight-node.scrollTop-node.clientHeight<5),'following output stays at the tail after wrapping changes');
    await pane.evaluate(node=>{node.scrollTop=60;});await page.waitForTimeout(30);
    await page.setViewportSize({width:800,height:700});await page.waitForTimeout(100);
    assert.equal(await pane.evaluate(node=>node.scrollTop),60,'resizing preserves deliberate upward reading');
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('changed process output and controls stay live without replacing retained panes',async()=>{
    const {page,errors}=await open();
    const state=snapshot([]);
    state.view.processes=[{id:'7',execId:7,command:'Build',status:'running',output:'Output\n'.repeat(80)}];
    await emit(page,state);
    await page.locator('#processDetails > summary').click();await page.locator('.activity-process > summary').click();
    const pane=page.locator('.process-output');
    await pane.evaluate(node=>{window.originalProcessPane=node;node.scrollTop=node.scrollHeight;});
    state.view.processes[0].output+='Following new output\n'.repeat(10);await emit(page,state);
    assert(await pane.evaluate(node=>node===window.originalProcessPane&&node.scrollHeight-node.scrollTop-node.clientHeight<5),'new output follows while the reader is at its bottom');
    await pane.evaluate(node=>{node.scrollTop=60;});await page.waitForTimeout(20);
    state.view.processes[0].output+='More live output\n'.repeat(10);await emit(page,state);
    assert.equal(await pane.evaluate(node=>node.scrollTop),60,'new output preserves deliberate upward reading');
    await page.getByRole('button',{name:'Stop',exact:true}).click();
    assert(await page.evaluate(()=>window.posted.some(m=>m.type==='interrupt'&&Number(m.execId)===7)));
    state.view.cached=true;await emit(page,state);assert.equal(await page.locator('.process-stop').isVisible(),false);
    state.view.cached=false;state.view.replayComplete=false;await emit(page,state);assert.equal(await page.locator('.process-stop').isVisible(),false);
    state.view.replayComplete=true;await emit(page,state);assert(await page.locator('.process-stop').isVisible());
    state.view.processes[0]={...state.view.processes[0],status:'exited',exitCode:1,shellExit:2,error:'Build failed',outputTruncated:true};await emit(page,state);
    assert.equal(await page.locator('.process-status').textContent(),'exited · exit 1 · shell 2 · Build failed · retained output tail');
    assert.equal(await page.locator('.process-stop').isVisible(),false);
    state.view.processes[0]={id:'7',execId:7,command:'Next build',status:'running',output:'Replacement output'};await emit(page,state);
    assert.equal(await pane.textContent(),'Replacement output');assert.equal(await page.locator('.process-command').textContent(),'Next build');
    assert(await pane.evaluate(node=>node===window.originalProcessPane),'a reused process ID updates the retained pane');
    state.view.processes=[];await emit(page,state);assert.equal(await page.locator('.activity-process').count(),0);
    assert.deepEqual(errors,[]);await page.close();
  });
  assert.deepEqual(failures,[],'Chromium activity regressions failed');
}finally{await browser.close();}
