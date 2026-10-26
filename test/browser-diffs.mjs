// Optional real Chromium checks; use PLAYWRIGHT_PATH as documented in README.md.
import assert from 'node:assert/strict';
import {createRequire,Module} from 'node:module';
import fs from 'node:fs';
const require=createRequire(import.meta.url),load=Module._load;
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
Module._load=function(name,...args){return name==='vscode'?{Uri:{joinPath:()=>({toString:()=>''})}}:load.call(this,name,...args);};
const {SessionPanel}=require('../out/panel.js');Module._load=load;
const panel=Object.create(SessionPanel.prototype);
panel.controller={sessionId:'diff-session'};
panel.panel={webview:{cspSource:'https://webview.local'}};
panel.markUri='data:image/svg+xml;base64,'+fs.readFileSync(new URL('../media/icon.svg',import.meta.url)).toString('base64');
panel.markdownUri='https://webview.local/markdown.js';
const html=panel.html().replace(/<script nonce="([^"]+)" src="[^"]+"><\/script>/,(_,nonce)=>'<script nonce="'+nonce+'">'+fs.readFileSync(new URL('../out/markdown.js',import.meta.url),'utf8')+'</script>');
const browser=await chromium.launch({headless:true});
const patch='diff --git a/src/session.ts b/src/session.ts\nindex 1234567..2345678 100644\n--- a/src/session.ts\n+++ b/src/session.ts\n@@ -12,5 +12,7 @@ function sendDraft() {\n const draft = composer.value;\n-send(draft);\n-composer.value = "";\n+const receipt = await send(draft);\n+if (receipt.accepted && composer.value === draft) {\n+  composer.value = "";\n+}\n saveDraft();\n }\n';
const longPatch='@@ -1,100 +1,100 @@\n'+Array.from({length:100},(_,i)=>' '+String(i+1).padStart(3,'0')+' '+('long source text '.repeat(18))).join('\n');
const rows=[
  {path:'src/session.ts',added:4,removed:2,patch,changeCount:3,callId:'change'},
  {path:'src/manager.ts',added:0,removed:0,patch:longPatch,changeCount:1,callId:'large'},
  {path:'test/<img src=x onerror="evil()">.mjs',patch:'@@ -0,0 +1 @@\n+<script>evil()</script>',changeCount:1,callId:'unsafe'},
  {path:'media/preview.png',binary:true,changeCount:1,callId:'binary'},
  {path:'removed-file.ts',added:0,removed:8,truncated:true,changeCount:1,callId:'missing'},
];
const state={type:'state',connection:'connected',attempts:0,history:[],view:{title:'Session changes',sessionId:'diff-session',cwd:'/workspace',totals:{},parts:[{kind:'assistant',text:'Updated the send flow and added regression coverage. Recorded changes are available below.',reasoning:'',durable:true,streaming:false,turnNumber:1}],queue:[],threads:[],processes:[],modifiedFiles:rows,replayComplete:true}};
const emit=(page,message)=>page.evaluate(m=>window.dispatchEvent(new MessageEvent('message',{data:m})),message);
async function open(saved={}){
  const page=await browser.newPage({viewport:{width:760,height:920}});page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(saved=>{window.posted=[];window.savedState=saved;window.acquireVsCodeApi=()=>({postMessage:m=>window.posted.push(m),getState:()=>window.savedState,setState:s=>{window.savedState=structuredClone(s);}});},saved);
  await page.goto('data:text/html,'+encodeURIComponent(html));await page.waitForFunction(()=>window.posted.some(m=>m.type==='ready'));
  await emit(page,state);return {page,errors};
}
const file=(page,path)=>page.locator('#fileList > [data-file-path]').filter({has:page.locator('button[data-p='+JSON.stringify(path)+']')});
const toggle=locator=>locator.locator('summary');
const tool=(id,turn,path='src/session.ts')=>({kind:'tool',turnNumber:turn,call:{callId:id,sessionId:'diff-session',turnId:'turn-'+turn,name:'edit',arguments:'{}',done:true,status:'done',result:'Updated file',metadata:{workspace_diff:{files:[{...rows[0],path}]}}}});
try{
  const {page,errors}=await open();await page.locator('#fileSummary').click();
  assert.equal(await page.locator('#fileList > .diff-file').count(),5);
  assert((await page.locator('#fileSummary').textContent()).includes('+?'));
  assert.equal(await page.locator('#fileList summary button').count(),0);
  const first=file(page,'src/session.ts');assert((await first.boundingBox()).height<=40);
  await toggle(first).click();await page.waitForFunction(()=>document.querySelector('#fileList .diff-summary').getAttribute('aria-expanded')==='true');assert.equal(await first.locator('summary').getAttribute('aria-expanded'),'true');
  assert.equal(await first.locator('.diff-add').count(),4);assert.equal(await first.locator('.diff-remove').count(),2);
  assert.deepEqual(await first.locator('.diff-add .diff-gutter').evaluateAll(nodes=>nodes.map(n=>[n.dataset.old,n.dataset.new])),[['','13'],['','14'],['','15'],['','16']]);
  assert((await first.locator('.diff-add').first().evaluate(n=>getComputedStyle(n).backgroundColor))!=='rgba(0, 0, 0, 0)');
  assert.equal(await page.locator('#fileList script,#fileList img').count(),0);
  const copied=await first.locator('.diff-code').evaluate(pane=>{const range=document.createRange();range.selectNodeContents(pane);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return selection.toString();});
  assert.equal(copied,patch.trimEnd(),'copy excludes line-number gutters and retains the recorded patch');
  await page.evaluate(()=>getSelection().removeAllRanges());
  const postedBefore=await page.evaluate(()=>window.posted.filter(m=>m.type==='openFile').length);
  await first.locator('.diff-open').click();assert.equal(await first.locator('details').getAttribute('open'),'');
  assert.deepEqual(await page.evaluate(()=>window.posted.filter(m=>m.type==='openFile').at(-1)),{type:'openFile',path:'src/session.ts'});
  assert.equal(await page.evaluate(()=>window.posted.filter(m=>m.type==='openFile').length),postedBefore+1);
  await toggle(first).focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('#fileList .diff-summary').getAttribute('aria-expanded')==='false');assert.equal(await first.locator('summary').getAttribute('aria-expanded'),'false');
  await page.keyboard.press('Enter');
  await toggle(file(page,'media/preview.png')).click();assert((await file(page,'media/preview.png').textContent()).includes('no text preview'));
  await toggle(file(page,'removed-file.ts')).click();assert((await file(page,'removed-file.ts').textContent()).includes('truncated'));assert((await file(page,'removed-file.ts').textContent()).includes('No textual patch was recorded'));
  await toggle(file(page,rows[2].path)).click();assert.equal(await file(page,rows[2].path).locator('.diff-source').last().textContent(),'<script>evil()</script>');assert.equal(await page.locator('#fileList script,#fileList img').count(),0);
  console.log('PASS diff rendering: compact rows, colors, line numbers, safe source, exact copy, independent navigation, keyboard disclosure and missing/binary states');

  const large=file(page,'src/manager.ts');await toggle(large).click();
  await large.locator('.diff-code').evaluate(pane=>{pane.scrollTop=190;pane.scrollLeft=240;pane.focus();});await page.waitForTimeout(70);
  const position=await large.locator('.diff-code').evaluate(pane=>[pane.scrollTop,pane.scrollLeft]);assert(position[0]>0&&position[1]>0);
  await large.locator('.diff-code').evaluate(pane=>window.sameDiffPane=pane);
  await emit(page,{...state,view:{...state.view,title:'Unrelated streaming update'}});
  assert(await large.locator('.diff-code').evaluate(pane=>pane===window.sameDiffPane));
  assert.deepEqual(await large.locator('.diff-code').evaluate(pane=>[pane.scrollTop,pane.scrollLeft]),position);
  assert(await large.locator('.diff-code').evaluate(pane=>document.activeElement===pane));
  const updated={...state,view:{...state.view,modifiedFiles:rows.map(row=>row.path==='src/session.ts'?{...row,added:5}:row)}};
  await emit(page,updated);assert(await large.locator('.diff-code').evaluate(pane=>pane===window.sameDiffPane));assert(await large.locator('.diff-code').evaluate(pane=>document.activeElement===pane));
  await large.locator('.diff-open').focus();await emit(page,{...updated,view:{...updated.view,modifiedFiles:updated.view.modifiedFiles.map(row=>row.path==='src/manager.ts'?{...row,changeCount:2}:row)}});
  assert(await large.locator('.diff-open').evaluate(button=>document.activeElement===button));
  assert.deepEqual(await large.locator('.diff-code').evaluate(pane=>[pane.scrollTop,pane.scrollLeft]),position);
  await large.locator('.diff-code').evaluate(pane=>{const range=document.createRange();range.selectNodeContents(pane.querySelectorAll('.diff-source')[4]);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);window.selectedDiffPane=pane;});
  const selected=await page.evaluate(()=>getSelection().toString());
  const newPatch=longPatch.replace('001 long','001 CHANGED long');
  const selectedUpdate={...state,view:{...state.view,modifiedFiles:rows.map(row=>row.path==='src/manager.ts'?{...row,patch:newPatch}:row)}};
  await emit(page,selectedUpdate);assert.equal(await page.evaluate(()=>getSelection().toString()),selected);assert(await large.locator('.diff-code').evaluate(pane=>pane===window.selectedDiffPane));
  await page.evaluate(()=>getSelection().removeAllRanges());await page.waitForFunction(()=>document.querySelector('#fileList').textContent.includes('CHANGED long'));
  console.log('PASS diff updates: identical DOM retained; changed rows preserve focus and two-axis scroll; selections defer replacement until cleared');

  const saved=await page.evaluate(()=>window.savedState);const restored=await open(saved);
  assert.equal(await restored.page.locator('#fileDetails').getAttribute('open'),'');
  const restoredLarge=file(restored.page,'src/manager.ts');assert.equal(await restoredLarge.locator('details').getAttribute('open'),'');
  assert.deepEqual(await restoredLarge.locator('.diff-code').evaluate(pane=>[pane.scrollTop,pane.scrollLeft]),position);
  assert.deepEqual(restored.errors,[]);await restored.page.close();
  console.log('PASS diff recreation: disclosure and two-axis scroll restored from webview state');

  const toolState={...state,view:{...state.view,parts:[tool('reused',1),tool('reused',2),{...tool('bad',3),call:{...tool('bad',3).call,metadata:{workspace_diff:{files:[null,[],{path:'valid-no-counts.ts'}]}}}}]}};
  await emit(page,toolState);await page.locator('.tool > summary').nth(0).click();await page.locator('.tool > summary').nth(1).click();
  const toolDiff=page.locator('.tool-diff');await toolDiff.nth(0).locator('summary').click();assert.equal(await toolDiff.nth(0).locator('details').getAttribute('open'),'');assert.equal(await toolDiff.nth(1).locator('details').getAttribute('open'),null);
  assert.notEqual(await toolDiff.nth(0).locator('details').getAttribute('data-detail'),await toolDiff.nth(1).locator('details').getAttribute('data-detail'));
  await page.waitForFunction(()=>!document.querySelector('.tool-diff .diff-code').hasAttribute('data-diff-pending'));
  assert.equal(await toolDiff.nth(0).locator('.diff-code').textContent(),await first.locator('.diff-code').textContent());
  await toolDiff.nth(0).locator('.diff-open').focus();const changedTool={...toolState,view:{...toolState.view,parts:toolState.view.parts.map((part,i)=>i===0?{...part,call:{...part.call,result:'Updated receipt'}}:part)}};
  await emit(page,changedTool);assert(await toolDiff.nth(0).locator('.diff-open').evaluate(button=>document.activeElement===button));
  assert.equal(await toolDiff.nth(0).locator('summary').getAttribute('aria-expanded'),'true');assert.equal(await toolDiff.nth(1).locator('summary').getAttribute('aria-expanded'),'false');
  assert.equal(await page.locator('.tool > summary').nth(2).count(),1);assert((await toolDiff.nth(2).textContent()).includes('+?'));
  console.log('PASS tool diffs: shared renderer, malformed records skipped, repeated call IDs isolated across turns and focus restored');

  const transition=await open(),transitionPage=transition.page;
  const pairState={...state,view:{...state.view,modifiedFiles:rows.slice(0,2)}};
  await emit(transitionPage,pairState);await transitionPage.locator('#fileSummary').click();
  const transitionManager=file(transitionPage,'src/manager.ts');await transitionManager.locator('.diff-open').focus();
  await emit(transitionPage,{...pairState,view:{...pairState.view,modifiedFiles:[rows[1],rows[0]]}});
  assert(await transitionManager.locator('.diff-open').evaluate(button=>document.activeElement===button));
  const immediate=await transitionPage.evaluate(message=>{const details=Array.from(document.querySelectorAll('#fileList > .diff-file')).find(n=>n.dataset.filePath==='src/session.ts').querySelector('details');const before=details.open;details.querySelector('summary').click();window.dispatchEvent(new MessageEvent('message',{data:message}));return [before,Array.from(document.querySelectorAll('#fileList > .diff-file')).find(n=>n.dataset.filePath==='src/session.ts').querySelector('details').open];},{...pairState,view:{...pairState.view,modifiedFiles:[rows[1],{...rows[0],changeCount:4}]}});
  assert.deepEqual(immediate,[false,true],'a receipt before the asynchronous toggle event must not undo a click');
  const transitionFirst=file(transitionPage,'src/session.ts');await transitionFirst.locator('summary').focus();await transitionPage.waitForFunction(()=>document.querySelector('#fileList [data-file-path="src/session.ts"] summary').getAttribute('aria-expanded')==='true');
  const selectedBeforeRemoval=await transitionFirst.locator('.diff-source').nth(1).evaluate(node=>{const range=document.createRange();range.selectNodeContents(node);getSelection().removeAllRanges();getSelection().addRange(range);return getSelection().toString();});
  await emit(transitionPage,{...pairState,view:{...pairState.view,modifiedFiles:[]}});
  assert.equal(await transitionPage.evaluate(()=>getSelection().toString()),selectedBeforeRemoval);assert(await transitionPage.locator('#fileBar').isVisible());assert((await transitionPage.locator('#fileSummary').textContent()).includes('2'));
  await transitionPage.evaluate(()=>getSelection().removeAllRanges());await transitionPage.waitForFunction(()=>document.querySelector('#fileBar').classList.contains('hidden'));
  const changingCall=tool('growing-result',1,'b.ts');changingCall.call.metadata.workspace_diff.files=[{...rows[1],path:'b.ts'}];
  const changingState={...state,view:{...state.view,parts:[changingCall],modifiedFiles:[]}};
  await emit(transitionPage,changingState);await transitionPage.locator('.tool > summary').click();await transitionPage.locator('.tool-diff summary').click();
  const bPane=transitionPage.locator('.tool-diff .diff-code');await bPane.evaluate(pane=>{pane.scrollTop=180;pane.scrollLeft=200;pane.focus();});await transitionPage.waitForTimeout(60);
  const bPosition=await bPane.evaluate(pane=>[pane.scrollTop,pane.scrollLeft]);assert(bPosition[0]>0&&bPosition[1]>0);
  const changedCall={...changingCall,call:{...changingCall.call,metadata:{workspace_diff:{files:[{...rows[0],path:'a.ts'},...changingCall.call.metadata.workspace_diff.files]}}}};
  await emit(transitionPage,{...changingState,view:{...changingState.view,parts:[changedCall]}});
  const bAfter=transitionPage.locator('.tool-diff').filter({has:transitionPage.locator('button[data-p="b.ts"]')});
  assert.equal(await bAfter.locator('details').getAttribute('open'),'');assert.deepEqual(await bAfter.locator('.diff-code').evaluate(pane=>[pane.scrollTop,pane.scrollLeft]),bPosition);assert(await bAfter.locator('.diff-code').evaluate(pane=>document.activeElement===pane));
  assert.deepEqual(transition.errors,[]);await transitionPage.close();console.log('PASS diff transitions: reordered focus, immediate expansion receipt, selected-file removal, stable growing-result file keys and pane state');

  await emit(page,state);
  await page.evaluate(()=>{const manager=Array.from(document.querySelectorAll('#fileList > .diff-file')).find(node=>node.dataset.filePath==='src/manager.ts');manager.querySelector('details').open=false;document.querySelector('#fileList').scrollTop=0;document.querySelector('#fileList .diff-code').scrollTop=0;});
  await page.setViewportSize({width:360,height:760});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  assert(await page.evaluate(()=>Array.from(document.querySelectorAll('.diff-file')).every(node=>node.getBoundingClientRect().right<=innerWidth)));
  await page.screenshot({path:process.env.DIFF_SCREENSHOT||'/tmp/nodecode-diffs-narrow.png',fullPage:true});
  await page.setViewportSize({width:760,height:920});await page.screenshot({path:'/tmp/nodecode-diffs-wide.png',fullPage:true});
  await page.addStyleTag({content:':root{--vscode-editor-background:#fff;--vscode-editor-foreground:#202020;--vscode-descriptionForeground:#606060;--vscode-panel-border:#ddd;--vscode-sideBar-background:#f6f6f6;--vscode-diffEditor-insertedLineBackground:#e4f6e8;--vscode-diffEditor-removedLineBackground:#fce3e3;--vscode-gitDecoration-addedResourceForeground:#176b2c;--vscode-gitDecoration-deletedResourceForeground:#b52b2b}'});
  assert.equal(await first.locator('.diff-add').first().evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(228, 246, 232)');
  await page.screenshot({path:'/tmp/nodecode-diffs-light.png',fullPage:true});
  console.log('PASS diff layouts: 360px sidebar, wide panel and light-theme token overrides; screenshots saved');
  await page.setViewportSize({width:360,height:760});
  await emit(page,{...state,view:{...state.view,modifiedFiles:[{path:'six-digit.ts',added:1,removed:1,patch:'@@ -123456 +654321 @@\n-old\n+new',changeCount:1}]}});
  const sixDigit=file(page,'six-digit.ts');await toggle(sixDigit).click();
  assert.equal(await sixDigit.locator('.diff-add .diff-gutter').getAttribute('data-new'),'654321');
  assert(await sixDigit.locator('.diff-add').evaluate(line=>line.querySelector('.diff-gutter').getBoundingClientRect().right<line.querySelector('.diff-marker').getBoundingClientRect().left),'line number gutter must not overlap source');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  console.log('PASS large line numbers: six-digit gutters remain separate from source at 360px');
  const stressPatch='@@ -1,10000 +1,10000 @@\n'+Array.from({length:10000},(_,i)=>' line '+i+' source '.repeat(20)).join('\n');
  const stressState={...state,view:{...state.view,modifiedFiles:[{path:'large-recorded.ts',added:0,removed:0,patch:stressPatch,changeCount:1}]}};
  const renderMs=await page.evaluate(message=>{const start=performance.now();window.dispatchEvent(new MessageEvent('message',{data:message}));return Math.round(performance.now()-start);},stressState);
  const stressFile=file(page,'large-recorded.ts');assert.equal(await stressFile.locator('.diff-line').count(),0);assert.equal(await stressFile.locator('.diff-code').textContent(),stressPatch);
  await toggle(stressFile).click();await page.waitForFunction(()=>document.querySelectorAll('#fileList .diff-line').length===10001);
  assert.equal(await stressFile.locator('.diff-gutter').last().getAttribute('data-new'),'10000');assert.equal(await stressFile.locator('.diff-source').last().textContent(),'line 9999'+' source '.repeat(20));
  assert.deepEqual(errors,[]);await page.close();console.log('PASS large diff: 10,000 lines retained, no closed line DOM, all line numbers restored on expansion (closed render '+renderMs+'ms)');
}finally{await browser.close();}
