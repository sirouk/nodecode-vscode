// Optional real Chromium regressions; use the same PLAYWRIGHT_PATH as browser-smoke.mjs.
import assert from 'node:assert/strict';
import {createRequire,Module} from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import {once} from 'node:events';
const require=createRequire(import.meta.url),load=Module._load;
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
Module._load=function(name,...args){return name==='vscode'?{Uri:{joinPath:()=>({toString:()=>''})}}:load.call(this,name,...args);};
const {SessionPanel}=require('../out/panel.js');Module._load=load;
const panel=Object.create(SessionPanel.prototype);
panel.controller={sessionId:'regression-session'};
panel.panel={webview:{cspSource:'https://webview.local'}};
panel.markUri='data:image/svg+xml;base64,'+fs.readFileSync(new URL('../media/icon.svg',import.meta.url)).toString('base64');
panel.markdownUri='https://webview.local/markdown.js';
const html=panel.html().replace(/<script nonce="([^"]+)" src="[^"]+"><\/script>/,(_,nonce)=>'<script nonce="'+nonce+'">'+fs.readFileSync(new URL('../out/markdown.js',import.meta.url),'utf8')+'</script>');
const browser=await chromium.launch({headless:true});
const state={type:'state',connection:'connected',attempts:0,history:['first prompt','second prompt'],view:{title:'Regression',sessionId:'regression-session',cwd:'/workspace',totals:{},parts:[],queue:[],threads:[],processes:[],replayComplete:true}};
const png={name:'draft.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZcToAAAAASUVORK5CYII=','base64')};
const emit=(page,message)=>page.evaluate(m=>window.dispatchEvent(new MessageEvent('message',{data:m})),message);
async function open(saved={}){
  const page=await browser.newPage({viewport:{width:360,height:700}});page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(saved=>{window.posted=[];window.savedState=saved;window.acquireVsCodeApi=()=>({postMessage:m=>window.posted.push(m),getState:()=>window.savedState,setState:s=>{window.savedState=structuredClone(s);}});},saved);
  await page.goto('data:text/html,'+encodeURIComponent(html));
  await page.waitForFunction(()=>window.posted.some(m=>m.type==='ready'));
  await emit(page,state);return {page,errors};
}
const savedDraft=page=>page.evaluate(()=>window.savedState.sessions?.['regression-session']);
const posted=(page,type)=>page.evaluate(type=>window.posted.filter(m=>m.type===type).at(-1),type);
const failures=[];
async function check(name,run){try{await run();console.log('PASS '+name);}catch(error){failures.push(name);console.error('FAIL '+name+'\n'+error.stack);}}
try{
  await check('image additions, removals and partial batches persist across recreation',async()=>{
    const {page,errors}=await open();
    await page.locator('#imageInput').setInputFiles(png);await page.waitForFunction(()=>document.querySelectorAll('#attachments img').length===1);
    assert.equal((await savedDraft(page)).images.length,1);
    const restored=await open(await page.evaluate(()=>window.savedState));assert.equal(await restored.page.locator('#attachments img').count(),1);await restored.page.close();
    await page.getByRole('button',{name:'Remove image',exact:true}).click();assert.equal((await savedDraft(page)).images.length,0);
    await page.locator('#imageInput').setInputFiles([png,{name:'invalid.txt',mimeType:'text/plain',buffer:Buffer.from([255])}]);
    await page.waitForFunction(()=>!document.querySelector('#attachmentError').classList.contains('hidden'));
    assert.equal((await savedDraft(page)).images.length,1);assert.deepEqual(errors,[]);await page.close();
  });
  await check('prompt recall navigates all entries and preserves edited drafts',async()=>{
    const {page,errors}=await open();const composer=page.locator('#composer');
    await composer.press('ArrowUp');assert.equal(await composer.inputValue(),'second prompt');assert.equal(await page.locator('#sendBtn').isDisabled(),false);
    assert.equal((await savedDraft(page)).draft,'second prompt');
    await composer.press('ArrowUp');assert.equal(await composer.inputValue(),'first prompt');
    await composer.press('ArrowDown');assert.equal(await composer.inputValue(),'second prompt');
    await composer.fill('second prompt edited');await composer.press('ArrowDown');assert.equal(await composer.inputValue(),'second prompt edited');
    await composer.fill('line one\nline two');await composer.press('ArrowUp');assert.equal(await composer.inputValue(),'line one\nline two');
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('runtime directory errors restore navigation controls',async()=>{
    const {page}=await open();await page.locator('#attachBtn').click();let request=await posted(page,'browseRuntimeFiles');
    await emit(page,{type:'runtimeFiles',requestId:request.requestId,result:{path:'/workspace',parent:'/',entries:[{name:'restricted',path:'/workspace/restricted',isDirectory:true}],offset:0,nextOffset:100,total:101}});
    await page.locator('[data-runtime-directory]').click();request=await posted(page,'browseRuntimeFiles');
    assert.equal(await page.locator('#runtimeUp').isDisabled(),true);
    await emit(page,{type:'runtimeFiles',requestId:request.requestId,error:'Directory unreadable'});
    assert.equal(await page.locator('#runtimeUp').isDisabled(),false);assert.equal(await page.locator('#runtimeMore').isDisabled(),false);
    assert.equal(await page.locator('#runtimeFileStatus').textContent(),'Directory unreadable');await page.close();
  });
  await check('parent-only thread changes invalidate the render cache',async()=>{
    const {page}=await open();
    for(const id of ['parent-a','parent-b']){await emit(page,{...state,view:{...state.view,parentId:id}});assert.equal(await page.locator('#threadList [data-p]').getAttribute('data-p'),id);}
    await page.close();
  });
  await check('threads keep non-idle work and one recent idle above the default-collapsed idle fold',async()=>{
    const {page,errors}=await open(),at=hour=>'2026-10-26T'+String(hour).padStart(2,'0')+':00:00Z';
    const row=(id,status,time)=>({id,title:id,kind:'subagent',status,relativeDepth:1,createdAt:at(7),...(status==='idle'?{updatedAt:at(time)}:{startedAt:at(time)})});
    let descendants=[row('idle-old','idle',9),row('active-old','running',10),row('idle-latest','idle',18),row('active-new','running',17),row('idle-middle','idle',12),row('failed','failed',14),row('unknown','unknown',15)];
    const parents=[{...row('parent','running',8),relativeDepth:-1}],siblings=[{...row('waiting','waiting',16),relativeDepth:0}];
    const snapshot=()=>({...state,view:{...state.view,parentId:'parent',ancestors:parents,siblings,descendants}});
    const ids=selector=>page.locator(selector+' [data-a="openThread"]').evaluateAll(rows=>rows.map(row=>row.dataset.p));
    await emit(page,snapshot());
    assert.equal(await page.locator('#threadDetails').evaluate(node=>node.open),false);
    await page.locator('#threadDetails > summary').click();
    assert.deepEqual(await ids('#activeThreadList'),['active-new','waiting','unknown','failed','active-old','parent','idle-latest']);
    assert.deepEqual(await ids('#idleThreadList'),['idle-middle','idle-old']);
    assert.equal(await page.locator('#idleThreadDetails').evaluate(node=>node.open),false);
    assert.equal(await page.locator('#idleThreadList [data-p="idle-middle"]').isVisible(),false);
    for(const id of ['active-new','waiting','unknown','failed','active-old','parent','idle-latest'])assert(await page.locator('#activeThreadList [data-p="'+id+'"]').isVisible(),id+' should remain above the idle fold');
    assert.equal(await page.locator('#threadList .activity-group').count(),0,'relationship headings must not consume the compact list');
    assert.match(await page.locator('#activeThreadList [data-p="parent"]').getAttribute('title'),/Parent/i);
    assert.match(await page.locator('#activeThreadList [data-p="waiting"]').getAttribute('title'),/Sibling/i);
    await page.locator('#activeThreadList [data-p="active-new"]').click();
    assert.equal((await posted(page,'openThread')).sessionId,'active-new');
    await page.locator('#idleThreadSummary').click();
    await page.waitForFunction(()=>window.savedState.sessions?.['regression-session'].expanded?.['section-thread-idle']===true);
    await page.locator('#idleThreadList [data-p="idle-middle"]').click();assert.equal((await posted(page,'openThread')).sessionId,'idle-middle');
    descendants=descendants.map(thread=>thread.id==='idle-middle'?{...thread,title:'Renamed idle thread'}:thread);
    await emit(page,snapshot());
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.p),'idle-middle','row focus survives an unrelated list refresh');
    await page.locator('#idleThreadSummary').focus();
    await page.evaluate(()=>window.idleSummaryNode=document.querySelector('#idleThreadSummary'));
    descendants=descendants.map(thread=>thread.id==='active-new'?{...thread,status:'idle',updatedAt:at(20)}:thread);
    await emit(page,snapshot());
    assert.deepEqual(await ids('#activeThreadList'),['waiting','unknown','failed','active-old','parent','active-new']);
    assert.deepEqual(await ids('#idleThreadList'),['idle-latest','idle-middle','idle-old']);
    assert(await page.locator('#idleThreadDetails').evaluate(node=>node.open));
    assert(await page.evaluate(()=>document.activeElement===window.idleSummaryNode&&window.idleSummaryNode===document.querySelector('#idleThreadSummary')),'summary focus and identity survive live regrouping');
    let restored=await open(await page.evaluate(()=>window.savedState));await emit(restored.page,snapshot());
    assert(await restored.page.locator('#threadDetails').evaluate(node=>node.open));
    assert(await restored.page.locator('#idleThreadDetails').evaluate(node=>node.open),'expanded idle fold survives webview recreation');
    await restored.page.locator('#idleThreadSummary').click();
    await restored.page.waitForFunction(()=>window.savedState.sessions?.['regression-session'].expanded?.['section-thread-idle']===false);
    const collapsedState=await restored.page.evaluate(()=>window.savedState);await restored.page.close();
    restored=await open(collapsedState);await emit(restored.page,snapshot());
    assert.equal(await restored.page.locator('#idleThreadDetails').evaluate(node=>node.open),false);await restored.page.close();
    descendants=descendants.map(thread=>thread.id==='active-new'?{...thread,status:'running',startedAt:at(21)}:thread);
    await emit(page,snapshot());
    assert.deepEqual(await ids('#activeThreadList'),['active-new','waiting','unknown','failed','active-old','parent','idle-latest']);
    assert.equal((await ids('#threadList')).filter(id=>id==='active-new').length,1);
    await emit(page,{...state,view:{...state.view,descendants:[row('only-idle','idle',10)]}});
    assert.deepEqual(await ids('#activeThreadList'),['only-idle']);assert.equal(await page.locator('#idleThreadDetails').isVisible(),false);
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('idle regrouping keeps keyboard focus on visible rows or disclosure summaries',async()=>{
    const {page,errors}=await open();
    let descendants=[{id:'latest',title:'Latest idle',status:'idle',updatedAt:'2026-10-26T16:00:00Z'},{id:'new',title:'Working',status:'running',startedAt:'2026-10-26T17:00:00Z'}];
    const snapshot=()=>({...state,view:{...state.view,descendants}});
    const focused=()=>page.evaluate(()=>document.activeElement.id||document.activeElement.dataset.p);
    await emit(page,snapshot());await page.locator('#threadDetails > summary').click();
    await page.locator('#activeThreadList [data-p="latest"]').focus();
    descendants=descendants.map(row=>row.id==='new'?{...row,status:'idle',updatedAt:'2026-10-26T18:00:00Z'}:row);await emit(page,snapshot());
    assert.equal(await focused(),'idleThreadSummary');assert.equal(await page.locator('#idleThreadDetails').evaluate(node=>node.open),false);
    descendants=descendants.map(row=>row.id==='latest'?{...row,status:'running'}:row);await emit(page,snapshot());
    assert.equal(await focused(),'threadSummary','focus leaves the now-hidden idle disclosure for its visible parent');
    descendants=descendants.map(row=>row.id==='latest'?{...row,status:'idle'}:row);await emit(page,snapshot());
    await page.locator('#idleThreadSummary').click();await page.locator('#idleThreadList [data-p="latest"]').focus();
    descendants=descendants.map(row=>row.id==='latest'?{...row,status:'running'}:row);await emit(page,snapshot());
    assert.equal(await focused(),'latest','an idle row moved into the visible active list retains focus');
    descendants=descendants.map(row=>row.id==='latest'?{...row,title:'Renamed working thread'}:row);await emit(page,snapshot());
    assert.equal(await focused(),'latest');assert.deepEqual(errors,[]);await page.close();
  });
  await check('large expanded thread sections stay compact and leave the conversation readable at sidebar widths',async()=>{
    const {page,errors}=await open();
    const descendants=Array.from({length:70},(_,i)=>({id:'compact-'+i,title:'A long thread title '+i+' '+('words '.repeat(9)),kind:'subagent',status:i<35?'running':'idle',relativeDepth:i%3+1,createdAt:'2026-10-26T10:00:00Z',startedAt:'2026-10-26T12:00:00Z',updatedAt:'2026-10-26T13:00:00Z'}));
    const fixture={...state,view:{...state.view,descendants,parts:[{kind:'assistant',text:'The conversation remains readable while many forks exist.\n\n'+'Visible answer content. '.repeat(80),reasoning:'',durable:true,streaming:false}]}};
    await emit(page,fixture);await page.locator('#threadDetails > summary').click();
    await page.locator('#idleThreadSummary').click();
    for(const viewport of [{width:360,height:700},{width:320,height:500}]){
      await page.setViewportSize(viewport);
      const size=await page.evaluate(()=>({list:document.querySelector('#threadList').getBoundingClientRect().height,conversation:document.querySelector('#conversation').getBoundingClientRect().height,scrollable:document.querySelector('#threadList').scrollHeight>document.querySelector('#threadList').clientHeight,overflow:document.documentElement.scrollWidth>window.innerWidth}));
      assert(size.list<=Math.min(160,viewport.height*.22)+1,'thread section must honor its compact viewport cap');
      assert(size.conversation>=viewport.height*.25,'conversation must retain a useful reading area');
      assert(size.scrollable,'all remaining rows should be reachable by internal scrolling');assert.equal(size.overflow,false);
      assert.equal(await page.locator('#composer').isVisible(),true);
    }
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('spawn notices use the concise prefix and a compact matching fork-color cap, including cached notices',async()=>{
    const {page,errors}=await open();const title='Research fork '+('with a long descriptive title '.repeat(10));
    const descendants=[{id:'colored-fork',title,status:'running',kind:'subagent',relativeDepth:1}];
    for(const prefix of ['Spawned subagent: ','Spawned: ']){
      await emit(page,{...state,view:{...state.view,descendants,parts:[{kind:'system',text:prefix+title,level:'info',childSessionId:'colored-fork'},{kind:'system',text:'Ordinary system notification',level:'info'}]}});
      const notice=page.locator('.spawn-notice');
      assert.equal(await notice.count(),1);assert.equal(await notice.textContent(),'Spawned: '+title);
      const button=notice.locator('[data-a="openThread"]');assert.equal(await button.getAttribute('data-p'),'colored-fork');
      assert((await notice.getAttribute('title')||await button.getAttribute('title')).includes(title),'full fork title remains available without wrapping');
      const card=await notice.evaluate(node=>{const s=getComputedStyle(node);return {height:node.getBoundingClientRect().height,borderWidth:parseFloat(s.borderLeftWidth),color:s.borderLeftColor};});
      const dotColor=await page.locator('#threadList [data-p="colored-fork"] .agent-dot').evaluate(node=>getComputedStyle(node).backgroundColor);
      assert.equal(card.borderWidth,3,'the leftmost card cap should remain visible');assert.equal(card.color,dotColor);
      assert(card.height<=32,'spawn notifications must remain a compact single line at sidebar widths');
      assert.equal(await page.locator('#transcript .sys:not(.spawn-notice)').textContent(),'Ordinary system notification');
      await button.click();assert.equal((await posted(page,'openThread')).sessionId,'colored-fork');
    }
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));assert.deepEqual(errors,[]);await page.close();
  });
  await check('favorite errors use their own identity and restore authoritative state',async()=>{
    const {page}=await open();let optionId;
    for(let i=0;i<3;i++){await page.locator('#modelBtn').click();optionId=(await posted(page,'modelOptions')).requestId;if(i<2)await page.locator('#optionClose').click();}
    await emit(page,{type:'modelOptions',requestId:optionId,models:[{provider:'alpha',model:'m',name:'Model'}],target:{},favorites:[]});
    await page.getByRole('button',{name:'Star alpha/m',exact:true}).click();const favorite=await posted(page,'favoriteModel');assert.notEqual(favorite.requestId,optionId);
    await emit(page,{type:'modelFavoriteError',requestId:favorite.requestId,message:'Favorite storage unavailable'});
    assert.equal(await page.getByRole('button',{name:'Star alpha/m',exact:true}).getAttribute('aria-pressed'),'false');
    assert.equal(await page.locator('#optionStatus').textContent(),'Favorite storage unavailable');await page.close();
  });
  await check('fork and bookmark buttons settle without an intervening state update',async()=>{
    const {page}=await open();
    await emit(page,{...state,view:{...state.view,parts:[{kind:'assistant',text:'Recorded',reasoning:'',durable:true,streaming:false,forkTurnId:'recorded-turn'}]}});
    // Prime the incremental renderer's action-markup cache before clicking.
    await emit(page,{...state,view:{...state.view,parts:[{kind:'assistant',text:'Recorded',reasoning:'',durable:true,streaming:false,forkTurnId:'recorded-turn'}]}});
    for(const [action,finished] of [['forkAtMessage','forkFinished'],['toggleCheckpointBookmark','bookmarkFinished']]){
      await page.locator('.msg.assistant').hover();await page.locator('[data-a="'+action+'"]').click();assert(await page.locator('[data-a="'+action+'"]').isDisabled());
      await emit(page,{type:finished,turnId:'recorded-turn'});assert.equal(await page.locator('[data-a="'+action+'"]').isDisabled(),false);
    }
    await page.close();
  });
  await check('footer displays latest context including cache reads and writes, not cumulative input',async()=>{
    const {page}=await open();
    await emit(page,{...state,view:{...state.view,totals:{input:99000,output:12000,cached:2200000,cacheWrite:50000,total:2361000},contextUsage:{input:1000,cached:2000,cacheWrite:300}}});
    assert((await page.locator('#statusLine').textContent()).includes('ctx 3.3 K · 2.4 M tokens'));
    assert((await page.locator('#statusLine>span').last().getAttribute('title')).includes('3,300'));
    assert((await page.locator('#statusLine>span').last().getAttribute('title')).includes('12 K (12,000)'));
    await page.close();
  });
  await check('cached history renders recent messages and full totals immediately but cannot submit before authoritative resume',async()=>{
    const {page,errors}=await open();
    const parts=Array.from({length:1200},(_,i)=>({kind:'assistant',text:'Saved reply '+i,reasoning:'',turnNumber:i+1,durable:true,streaming:false,forkTurnId:'turn-'+i}));
    const cached={...state,connection:'connecting',view:{...state.view,cached:true,replayComplete:false,parts,totals:{input:1000000,output:200000,cached:300000,cacheWrite:20000,total:1520000},contextUsage:{input:1200,cached:3000,cacheWrite:50},descendants:[{id:'agent',title:'Saved agent',status:'unknown',kind:'subagent'}],modifiedFiles:[{path:'src/saved.ts',added:2,removed:1,changeCount:1}],processes:[{id:'1',execId:1,status:'running',command:'saved process',output:'last observed',outputTruncated:false}]}};
    await emit(page,cached);
    assert((await page.locator('#transcript').textContent()).includes('Saved reply 1199'));
    assert((await page.locator('#statusLine').textContent()).includes('Syncing saved history'));
    assert((await page.locator('#statusLine').textContent()).includes('ctx 4.3 K · 1.5 M tokens'));
    assert((await page.locator('#threadSummary').textContent()).includes('1'));assert((await page.locator('#fileSummary').textContent()).includes('1'));
    assert.equal(await page.locator('.fork-turn').count(),0);assert.equal(await page.locator('.process-stop:not(.hidden)').count(),0);
    await page.locator('#composer').fill('Do not send while syncing');await page.locator('#composer').press('Enter');
    assert.equal(await page.locator('#sendBtn').isDisabled(),true);assert.equal(await posted(page,'send'),undefined);
    const visible=await page.locator('#transcript').textContent();
    await emit(page,{...cached,connection:'connected',view:{...cached.view,cached:false,replayComplete:true,processes:[]}});
    assert.equal(await page.locator('#transcript').textContent(),visible);assert.equal(await page.locator('#sendBtn').isDisabled(),false);
    assert((await page.locator('#statusLine').textContent()).includes('1.5 M tokens'));assert.deepEqual(errors,[]);await page.close();
  });
  await check('outstanding sends survive recreation and ignore stale acknowledgements',async()=>{
    let {page}=await open();await page.locator('#composer').fill('Original send');await page.locator('#imageInput').setInputFiles(png);
    await page.waitForFunction(()=>document.querySelectorAll('#attachments img').length===1);await page.locator('#sendBtn').click();const original=await posted(page,'send');assert.equal(typeof original.requestId,'string');
    const saved=await page.evaluate(()=>window.savedState);await page.close();({page}=await open(saved));
    assert.equal(await page.locator('#sendBtn').isDisabled(),true);assert.equal((await posted(page,'ready')).pendingSendId,original.requestId);
    await page.locator('#composer').fill('New draft');
    await emit(page,{type:'sendRejected',requestId:'unrelated'});assert.equal(await page.locator('#sendBtn').isDisabled(),true);
    await emit(page,{type:'sendAccepted',requestId:original.requestId,text:'Original send'});
    assert.equal(await page.locator('#composer').inputValue(),'New draft');assert.equal(await page.locator('#attachments img').count(),0);
    await page.locator('#imageInput').setInputFiles({...png,name:'new.png'});await page.waitForFunction(()=>document.querySelectorAll('#attachments img').length===1);
    await emit(page,{type:'sendAccepted',requestId:original.requestId,text:'Original send'});assert.equal(await page.locator('#attachments img').count(),1);
    assert.equal(await page.locator('#composer').inputValue(),'New draft');await page.close();
  });
  await check('Enter repeatedly steers the active response and Queue is explicit for one send only',async()=>{
    const {page,errors}=await open(),composer=page.locator('#composer');
    const active={...state,view:{...state.view,running:true,activeTurnId:'turn-A',activeTurnSteerable:true}};
    await emit(page,active);await composer.fill('Correct this now');
    assert.equal(await page.locator('#sendBtn').getAttribute('aria-label'),'Steer active response');
    assert((await page.locator('#composerHint').textContent()).includes('Enter to steer'));
    await composer.press('Enter');let sent=await posted(page,'send');
    assert.equal(sent.mode,'steer');assert.equal(sent.turnId,'turn-A');
    assert.equal(await page.locator('#statusLine .connection').textContent(),'Steering…');
    await emit(page,{type:'sendAccepted',requestId:sent.requestId});
    await composer.fill('Save this for later');await page.locator('#queueBtn').click();sent=await posted(page,'send');
    assert.equal(sent.mode,'queue');assert.equal(sent.turnId,undefined);
    assert.equal(await page.locator('#statusLine .connection').textContent(),'Queueing…');
    await emit(page,{type:'sendAccepted',requestId:sent.requestId});
    await composer.fill('Another immediate correction');await page.locator('#sendBtn').click();sent=await posted(page,'send');
    assert.equal(sent.mode,'steer');assert.equal(sent.turnId,'turn-A');
    await emit(page,{type:'sendRejected',requestId:sent.requestId,message:'Try again'});
    await composer.press('Enter');sent=await posted(page,'send');assert.equal(sent.mode,'steer');assert.equal(sent.turnId,'turn-A');
    await emit(page,{type:'sendAccepted',requestId:sent.requestId});
    await emit(page,state);await composer.fill('New work');await composer.press('Enter');sent=await posted(page,'send');
    assert.equal(sent.mode,undefined);assert.equal(sent.turnId,undefined);assert.equal(await page.locator('#queueBtn').isVisible(),false);
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('unavailable steering never silently queues on Enter, including reconnect and partial replay',async()=>{
    const {page,errors}=await open(),composer=page.locator('#composer');
    const active={...state,view:{...state.view,running:true,activeTurnId:'turn-A',activeTurnSteerable:true}};
    await emit(page,{...active,view:{...active.view,activeTurnSteerable:false}});await composer.fill('Must steer, not queue');
    assert.equal(await page.locator('#sendBtn').isDisabled(),true);assert.equal(await page.locator('#queueBtn').isDisabled(),false);
    await composer.press('Enter');assert.equal(await posted(page,'send'),undefined);assert((await page.locator('#attachmentError').textContent()).includes('cannot be steered'));
    await emit(page,{...active,connection:'connecting'});await composer.press('Enter');assert.equal(await posted(page,'send'),undefined);assert.equal(await page.locator('#queueBtn').isDisabled(),true);
    await emit(page,{...active,view:{...active.view,replayComplete:false}});await composer.press('Enter');assert.equal(await posted(page,'send'),undefined);
    await emit(page,active);await composer.press('Enter');const sent=await posted(page,'send');assert.equal(sent.mode,'steer');assert.equal(sent.turnId,'turn-A');
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('pending steering preserves its target across recreation without resubmission',async()=>{
    let {page}=await open();const active={...state,view:{...state.view,running:true,activeTurnId:'turn-A',activeTurnSteerable:true}};
    await emit(page,active);await page.locator('#composer').fill('Steer original work');await page.locator('#sendBtn').click();const sent=await posted(page,'send');
    assert.equal((await savedDraft(page)).pendingSend.mode,'steer');assert.equal((await savedDraft(page)).pendingSend.turnId,'turn-A');
    const saved=await page.evaluate(()=>window.savedState);await page.close();({page}=await open(saved));
    await emit(page,{...active,view:{...active.view,activeTurnId:'turn-B'}});
    assert.equal((await posted(page,'ready')).pendingSendId,sent.requestId);assert.equal(await posted(page,'send'),undefined);
    assert.equal(await page.locator('#sendBtn').isDisabled(),true);assert.equal(await page.locator('#queueBtn').isDisabled(),true);
    await page.locator('#composer').fill('New steering draft');await emit(page,{type:'sendAccepted',requestId:'stale'});assert.equal(await page.locator('#sendBtn').isDisabled(),true);
    await emit(page,{type:'sendRejected',requestId:sent.requestId,message:'The active turn changed'});
    assert.equal(await page.locator('#composer').inputValue(),'New steering draft');await page.locator('#composer').press('Enter');
    const retried=await posted(page,'send');assert.notEqual(retried.requestId,sent.requestId);assert.equal(retried.mode,'steer');assert.equal(retried.turnId,'turn-B');await page.close();
  });
  await check('pending steers and queued follow-ups are labeled distinctly and withdraw by native identity',async()=>{
    const {page}=await open();const queue=[{prompt_id:'later',content:'Same text'},{prompt_id:'now',content:'Same text',disposition:'steer'}];
    await emit(page,{...state,view:{...state.view,running:true,activeTurnId:'turn-A',activeTurnSteerable:true,queue}});
    const chips=page.locator('#queueBar .chip');assert.equal(await chips.count(),2);
    assert((await chips.nth(0).textContent()).startsWith('Queued: '));assert((await chips.nth(1).textContent()).startsWith('Steer pending: '));
    assert.match(await chips.nth(1).getAttribute('title'),/boundary; not yet delivered/);
    await page.locator('#queueBar [data-p="now"]').click();assert.equal((await posted(page,'withdraw')).promptId,'now');
    assert.equal(await chips.count(),2,'native state, not optimistic removal, confirms withdrawal');
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await page.close();
  });
  await check('authenticated saved images decode in cached history and the full-size preview',async()=>{
    const {NodecodeApi}=require('../out/api.js'),{SessionController}=require('../out/manager.js'),{SessionStore}=require('../out/store.js');
    const requests=[],server=http.createServer((req,res)=>{
      requests.push({url:req.url,auth:req.headers.authorization});
      if(req.headers.authorization!=='Bearer browser-image-token'||req.url.includes('?')){res.writeHead(401);res.end();return;}
      res.writeHead(200,{'Content-Type':'image/png'});res.end(png.buffer);
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const api=new NodecodeApi({current:()=>({baseUrl:`http://127.0.0.1:${server.address().port}`,token:'browser-image-token'})},{log(){}});
    const ctl=new SessionController({},{log(){}},api,'/workspace','saved-images'),projector=Object.create(SessionPanel.prototype),updates=[];
    const {page,errors}=await open();
    try{
      ctl.store.applyFrame({type:'session_stream_resumed',session_id:ctl.sessionId,replay_chunk_final:true,admission_state:'ready',accumulated_frames:[
        {type:'session_stream_event',sequence:1,event:{type:'turn.input_committed',payload:{message:'Saved image question',metadata:{images:[{id:'saved-png',media_type:'image/png'}]}}}},
        {type:'session_stream_event',sequence:2,event:{type:'turn.assistant_message_completed',payload:{message:'Saved image reply',metadata:{images:[{id:'saved-png',media_type:'image/png'}]}}}},
      ]});
      const cached=new SessionStore();cached.restoreProjection(JSON.parse(JSON.stringify(ctl.store.snapshotProjection())),ctl.sessionId);ctl.store=cached;
      Object.assign(projector,{controller:ctl,conversationImages:new Map(),notes:{log(){}},panel:{webview:{postMessage:m=>updates.push(m)}},connection:'connecting',connectionAttempts:0});
      projector.postState();assert.equal(updates[0].view.cached,true);await emit(page,updates[0]);
      assert.equal(await page.locator('.message-image').count(),0);assert.equal(await page.locator('.message-image-status').count(),2);
      await ctl.imageDataUrl('saved-png');await new Promise(setImmediate);await emit(page,updates.at(-1));
      await page.waitForFunction(()=>Array.from(document.querySelectorAll('.message-image')).length===2&&Array.from(document.querySelectorAll('.message-image')).every(image=>image.complete&&image.naturalWidth>0));
      assert.deepEqual(requests,[{url:'/api/gateway/sessions/saved-images/images/saved-png',auth:'Bearer browser-image-token'}]);
      for(const image of await page.locator('.message-image').all())assert((await image.getAttribute('src')).startsWith('data:image/png;base64,'));
      await page.locator('.message-image').first().click();await page.waitForFunction(()=>{var image=document.querySelector('#imagePreviewContent');return image.complete&&image.naturalWidth>0;});
      assert(await page.locator('#imagePreview').isVisible());await page.keyboard.press('Escape');
      await emit(page,{...state,view:{...state.view,parts:[{kind:'user',text:'Unavailable image',images:[{id:'missing',error:'gateway GET image -> 401'}]}]}});
      assert.match(await page.locator('.message-image-status').textContent(),/Image unavailable:.*401/);assert.equal(await page.locator('.message-image').count(),0);
      assert.deepEqual(errors,[]);
    }finally{projector.disposed=true;ctl.dispose();await page.close();server.close();await once(server,'close');}
  });
  await check('saved thoughts render safe inline Markdown and copy the original source',async()=>{
    const {page,errors}=await open();
    const reasoning='**Reviewing project tasks**\n\nUse `**literal**` and \\*\\*escaped\\*\\*.\n<script>window.thoughtInjected=1</script><img src=x onerror="window.thoughtInjected=1">\n[bad](javascript:alert) [web](https://example.com/thought) [file](src/panel.ts:12)\n\n  \t';
    await emit(page,{...state,view:{...state.view,parts:[{kind:'assistant',text:'Finished.',reasoning,streaming:false,durable:true}]}});
    await page.locator('.reasoning summary').click();const body=page.locator('.rbody');
    assert.equal(await body.locator('strong').textContent(),'Reviewing project tasks');
    assert(await body.locator('strong').evaluate(el=>parseFloat(getComputedStyle(el).fontWeight)>=600));
    assert((await body.textContent()).startsWith('Reviewing project tasks\n\nUse **literal** and **escaped**.'));
    assert.equal(await body.locator('code').textContent(),'**literal**');assert.equal(await body.locator('p,h1,ul,pre').count(),0,'inline formatting must not alter thought paragraph layout');
    assert.equal(await body.locator('script,img').count(),0);assert.equal(await page.evaluate(()=>window.thoughtInjected),undefined);
    assert.equal(await body.getByRole('link',{name:'bad',exact:true}).getAttribute('href'),'#');
    await body.getByRole('link',{name:'bad',exact:true}).click();assert.equal(await posted(page,'openExternal'),undefined);
    await body.getByRole('link',{name:'web',exact:true}).click();assert.equal((await posted(page,'openExternal')).url,'https://example.com/thought');
    await body.getByRole('link',{name:'file',exact:true}).click();assert.equal((await posted(page,'openFile')).path,'src/panel.ts');assert.equal((await posted(page,'openFile')).line,12);
    await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true});document.execCommand=()=>{window.copiedThought=document.activeElement.value;return true;};});
    await page.locator('.reasoning summary').hover();await page.getByRole('button',{name:'Copy thought process',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.copiedThought),reasoning,'copy must retain Markdown delimiters and trailing whitespace');
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('streamed thoughts render completed bold spans without duplicating text',async()=>{
    const {page,errors}=await open();let reasoning='**Reviewing';
    const snapshot=(streaming=true)=>({...state,view:{...state.view,running:streaming,parts:[{kind:'assistant',text:streaming?'':'Done.',reasoning,streaming,durable:!streaming}]}});
    await emit(page,snapshot());const body=page.locator('.rbody');assert.equal(await body.textContent(),reasoning);
    reasoning+=' project tasks**';await emit(page,snapshot());assert.equal(await body.locator('strong').textContent(),'Reviewing project tasks');
    reasoning+='\n\nMore **checks**.';await emit(page,snapshot());assert.deepEqual(await body.locator('strong').allTextContents(),['Reviewing project tasks','checks']);
    assert.equal(await body.textContent(),'Reviewing project tasks\n\nMore checks.');
    await body.locator('strong').first().evaluate(el=>window.firstThoughtStrong=el);await emit(page,snapshot());
    assert(await body.locator('strong').first().evaluate(el=>el===window.firstThoughtStrong),'unchanged source must retain rendered nodes');
    await emit(page,snapshot(false));assert.equal(await body.textContent(),'Reviewing project tasks\n\nMore checks.');assert(await page.locator('.reasoning').evaluate(el=>el.open));
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('formatted thought selections and paused scroll survive updates and catch up on release',async()=>{
    const {page,errors}=await open();let reasoning='**Reviewing project tasks**\n\n'+'A **bold** thought line.\n'.repeat(40)+'An unfinished **heading';
    const snapshot=()=>({...state,view:{...state.view,running:true,parts:[{kind:'assistant',text:'',reasoning,streaming:true}]}});
    await emit(page,snapshot());const body=page.locator('.rbody');await page.waitForFunction(()=>document.querySelector('.rbody')?.clientHeight>0);
    await body.evaluate(el=>{el.scrollTop=100;});await page.waitForTimeout(20);
    await body.evaluate(el=>{const text=el.querySelector('strong').firstChild,range=document.createRange();range.setStart(text,0);range.setEnd(text,9);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);window.selectedThoughtNode=text;});
    const before=await body.textContent(),outerBefore=await page.locator('#scroll').evaluate(el=>el.scrollTop);
    reasoning+='**\nNew **done** text.';await emit(page,snapshot());
    assert.equal(await page.evaluate(()=>window.getSelection().toString()),'Reviewing');assert(await body.locator('strong').first().evaluate(el=>el.firstChild===window.selectedThoughtNode));
    assert.equal(await body.textContent(),before);assert.equal(await body.evaluate(el=>el.scrollTop),100);assert.equal(await page.locator('#scroll').evaluate(el=>el.scrollTop),outerBefore);
    await page.evaluate(()=>window.getSelection().removeAllRanges());await page.waitForFunction(()=>document.querySelector('.rbody').textContent.endsWith('New done text.'));
    assert.deepEqual((await body.locator('strong').allTextContents()).slice(-2),['heading','done']);assert.equal(await body.evaluate(el=>el.scrollTop),100);
    await body.evaluate(el=>{const strong=el.querySelector('strong'),range=document.createRange();range.setStart(strong.firstChild,10);range.setEnd(strong.nextSibling,3);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);window.crossThoughtSelection=selection.toString();});
    reasoning+='\nAnother **update**.\n'.repeat(10);await emit(page,snapshot());assert.equal(await page.evaluate(()=>window.getSelection().toString()),await page.evaluate(()=>window.crossThoughtSelection));
    await body.evaluate(el=>{window.getSelection().removeAllRanges();document.dispatchEvent(new Event('selectionchange'));el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event('scroll'));});
    assert((await body.textContent()).endsWith('Another update.'));
    reasoning+='\nBack at **tail**.\n'.repeat(10);await emit(page,snapshot());
    assert(await body.evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight<5),'returning to the bottom immediately after selection catch-up must resume following');
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('thought panes omit trailing blank space while preserving paragraphs and copied source text',async()=>{
    const {page,errors}=await open();
    let reasoning='First paragraph.\n\n'+('A synthetic thought line.\n'.repeat(40))+'The last visible sentence.\n\n  \t';
    const snapshot=()=>({...state,view:{...state.view,running:true,parts:[{kind:'assistant',text:'',reasoning,streaming:true}]}});
    const measure=()=>page.locator('.rbody').evaluate(pane=>{
      pane.scrollTop=pane.scrollHeight;const node=pane.firstChild,range=document.createRange();
      range.setStart(node,node.length-1);range.setEnd(node,node.length);
      return {text:pane.textContent,gap:pane.getBoundingClientRect().bottom-range.getBoundingClientRect().bottom,padding:getComputedStyle(pane).paddingBottom};
    });
    await emit(page,snapshot());await page.waitForFunction(()=>document.querySelector('.rbody')?.clientHeight>0);
    let tail=await measure();assert.equal(tail.text,reasoning.trimEnd());assert(tail.text.startsWith('First paragraph.\n\n'));assert(tail.gap<6,'no blank line or bottom padding should follow the final visible character');assert.equal(tail.padding,'0px');
    reasoning+='\nAn appended paragraph after the original whitespace.\n\n';await emit(page,snapshot());
    tail=await measure();assert.equal(tail.text,reasoning.trimEnd());assert(tail.gap<6,'incremental updates must not restore the blank tail');
    await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true});document.execCommand=()=>{window.copiedThought=document.activeElement.value;return true;};});
    await page.locator('.reasoning summary').hover();await page.getByRole('button',{name:'Copy thought process',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.copiedThought),reasoning,'copy must retain the original text including trailing whitespace');
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('footer disclosures use tight rows without horizontal divider lines',async()=>{
    const {page,errors}=await open();
    const fixture={...state,view:{...state.view,descendants:[{id:'footer-thread',title:'Working thread',kind:'subagent',status:'running'}],modifiedFiles:[{path:'src/example.ts',additions:2,deletions:1}],parts:[{kind:'assistant',text:'The conversation has room to breathe.',reasoning:'',streaming:false}]}};
    await emit(page,fixture);
    for(const viewport of [{width:1108,height:650},{width:360,height:700}]){
      await page.setViewportSize(viewport);
      const metrics=await page.evaluate(()=>['threadBar','fileBar'].map(id=>{const node=document.getElementById(id),css=getComputedStyle(node);return {id,border:parseFloat(css.borderTopWidth),height:node.getBoundingClientRect().height,paddingTop:parseFloat(css.paddingTop),paddingBottom:parseFloat(css.paddingBottom)};}));
      for(const row of metrics){assert.equal(row.border,0,row.id+' must not have a separator');assert(row.height<=34,row.id+' collapsed row should stay compact');assert(row.paddingTop<=2&&row.paddingBottom<=2);}
      assert(await page.locator('#scroll').evaluate(node=>node.clientHeight>180),'compact footer leaves room for the transcript');
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    }
    await page.locator('#threadDetails > summary').click();assert(await page.locator('#activeThreadList [data-p="footer-thread"]').isVisible());
    await page.locator('#fileDetails > summary').click();assert(await page.locator('#fileList').isVisible());
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('passive thought shrink and incoming growth keep following through delayed layout capture',async()=>{
    const {page,errors}=await open();await page.setViewportSize({width:960,height:760});
    const history=Array.from({length:12},(_,i)=>({kind:'user',text:'Earlier '+i+' history '.repeat(100)}));
    let answer={kind:'assistant',text:'',reasoning:'Thinking line\n'.repeat(100),streaming:true};
    const snapshot=()=>({...state,view:{...state.view,running:true,parts:[...history,answer]}});
    await emit(page,snapshot());
    await page.waitForFunction(()=>{const pane=document.querySelector('#scroll');return pane.scrollHeight-pane.scrollTop-pane.clientHeight<2;});
    answer={...answer,reasoning:'Thinking complete.',text:'New incoming answer. '.repeat(300)};
    // Force the browser's clamp and later growth into one task, before observers/capture run.
    const race=await page.evaluate(message=>{
      const pane=document.querySelector('#scroll'),before=pane.scrollTop;
      document.querySelector('.rbody').textContent='Thinking complete.';
      const clamped=pane.scrollTop,smallHeight=pane.scrollHeight;
      document.querySelector('.reply-text').textContent=message.view.parts.at(-1).text;
      const grownHeight=pane.scrollHeight;
      window.dispatchEvent(new MessageEvent('message',{data:message}));
      return {before,clamped,smallHeight,grownHeight,follow:pane._follow};
    },snapshot());
    assert(race.clamped<race.before-20,'thought shrink must actually clamp the viewport');
    assert(race.grownHeight>race.smallHeight+100,'incoming text must grow before capture');
    assert.equal(race.follow,true,'layout-driven upward movement must not disable following');
    await page.waitForFunction(()=>{const pane=document.querySelector('#scroll');return pane.scrollHeight-pane.scrollTop-pane.clientHeight<2;});
    answer={...answer,text:answer.text+' Subsequent streaming content. '.repeat(100)};
    await emit(page,snapshot());
    await page.waitForFunction(()=>{const pane=document.querySelector('#scroll');return pane._follow&&pane.scrollHeight-pane.scrollTop-pane.clientHeight<2;});
    assert.equal(await page.locator('#jumpBtn').isVisible(),false);assert.deepEqual(errors,[]);await page.close();
  });
  await check('an upward pointer drag still pauses following when incoming content changes layout',async()=>{
    const {page,errors}=await open();await page.setViewportSize({width:960,height:760});
    const history=Array.from({length:12},(_,i)=>({kind:'user',text:'Earlier '+i+' history '.repeat(100)}));
    let answer={kind:'assistant',text:'Answer. '.repeat(200),reasoning:'Thinking line\n'.repeat(100),streaming:true};
    const snapshot=()=>({...state,view:{...state.view,running:true,parts:[...history,answer]}});
    await emit(page,snapshot());
    await page.waitForFunction(()=>{const pane=document.querySelector('#scroll');return pane.scrollHeight-pane.scrollTop-pane.clientHeight<2;});
    await page.locator('#scroll').dispatchEvent('pointerdown');
    await emit(page,snapshot()); // An unchanged render consumes the initial pointerdown intent.
    answer={...answer,text:answer.text+'New answer. '.repeat(200)};
    const drag=await page.evaluate(message=>{
      const pane=document.querySelector('#scroll');pane.scrollTop-=200;const held=pane.scrollTop;
      document.querySelector('.reply-text').textContent=message.view.parts.at(-1).text;
      window.dispatchEvent(new MessageEvent('message',{data:message}));
      return {held,follow:pane._follow,top:pane.scrollTop};
    },snapshot());
    assert.equal(drag.follow,false,'an active upward drag remains reader intent during reflow');assert(Math.abs(drag.top-drag.held)<1);
    await page.evaluate(()=>document.dispatchEvent(new PointerEvent('pointerup')));
    answer={...answer,text:answer.text+' Further incoming content. '.repeat(80)};await emit(page,snapshot());
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert(Math.abs(await page.locator('#scroll').evaluate(pane=>pane.scrollTop)-drag.held)<1,'incoming content must leave the reader in place after release');
    assert(await page.locator('#jumpBtn').isVisible());await page.locator('#jumpBtn').click();
    await page.waitForFunction(()=>{const pane=document.querySelector('#scroll');return pane._follow&&pane.scrollHeight-pane.scrollTop-pane.clientHeight<2;});
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('response caret belongs only to the latest text response, never a thought-only or tool-running gap',async()=>{
    const {page,errors}=await open();
    const thought={kind:'assistant',text:'',reasoning:'Checking the current state.',streaming:true,durable:false};
    const show=parts=>emit(page,{...state,view:{...state.view,running:true,parts}});
    await show([thought]);assert.equal(await page.locator('.reply-caret .caret').count(),0,'thought-only streaming has no empty reply caret');
    const reply={...thought,text:'Checking the tool result.'};await show([reply]);assert.equal(await page.locator('.reply-caret .caret').count(),1,'actual current reply text retains its streaming indicator');
    const tool={kind:'tool',call:{callId:'running-eval',name:'eval',arguments:'(+ 1 2)',done:false,status:'running'}};
    await show([reply,tool]);assert.equal(await page.locator('.reply-caret .caret').count(),0,'a running eval must not leave a caret under the preceding reply');
    await show([{...reply,streaming:false,durable:true},tool]);assert.equal(await page.locator('.reply-caret .caret').count(),0);
    await show([{...reply,streaming:false,durable:true},{...tool,call:{...tool.call,done:true,result:'3'}},{...thought,text:'The result is 3.',reasoning:''}]);
    assert.equal(await page.locator('.reply-caret .caret').count(),1);assert.deepEqual(errors,[]);await page.close();
  });
  await check('activity children and nested idle rows are inset from their parent headings',async()=>{
    const {page,errors}=await open();
    await emit(page,{...state,view:{...state.view,
      descendants:[
        {id:'working',title:'Working thread '+('long title '.repeat(30)),kind:'subagent',status:'running'},
        {id:'recent-idle',title:'Recent idle thread',kind:'subagent',status:'idle',updatedAt:'2026-10-26T18:00:00Z'},
        {id:'older-idle',title:'Older idle thread '+('long title '.repeat(30)),kind:'subagent',status:'idle',updatedAt:'2026-10-26T17:00:00Z'},
      ],
      processes:[{id:'hierarchy-process',execId:7,command:'Inspect '+('long-command-'.repeat(30)),status:'running',output:'Retained process output'}],
      modifiedFiles:[{path:'src/'+('long-directory/'.repeat(5))+'panel.ts',added:1,removed:0,patch:'@@ -0,0 +1 @@\n+retained change'}],
    }});
    for(const id of ['processSummary','threadSummary','fileSummary','idleThreadSummary'])await page.locator('#'+id).click();
    for(const width of [320,360,960,1440]){
      await page.setViewportSize({width,height:1100});
      const rows=await page.evaluate(()=>[
        ['processSummary','#processList > .activity-process'],
        ['threadSummary','#activeThreadList > .activity-link'],
        ['threadSummary','#idleThreadDetails'],
        ['idleThreadSummary','#idleThreadList > .activity-link'],
        ['fileSummary','#fileList > .diff-file'],
      ].map(([id,selector])=>{const parent=document.getElementById(id).getBoundingClientRect(),child=document.querySelector(selector).getBoundingClientRect();return {id,inset:child.left-parent.left,right:child.right,parentRight:parent.right};}));
      for(const row of rows){
        assert(row.inset>=12,row.id+' children must be visibly indented, got '+row.inset+'px');
        assert(row.right<=row.parentRight+1,row.id+' children must stay inside the section');
      }
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'indented activity lists must not widen the page');
      assert(await page.locator('#composer').isVisible());
    }
    assert.deepEqual(errors,[]);await page.close();
  });
  assert.deepEqual(failures,[],'Chromium regressions failed');
}finally{await browser.close();}
