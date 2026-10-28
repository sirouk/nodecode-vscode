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
const html=sessionId=>{panel.controller={sessionId};return panel.html().replace(/<script nonce="([^"]+)" src="[^"]+"><\/script>/,(_,nonce)=>'<script nonce="'+nonce+'">'+fs.readFileSync(new URL('../out/markdown.js',import.meta.url),'utf8')+'</script>');};
const browser=await chromium.launch({headless:true});
const state={type:'state',connection:'connected',attempts:0,history:['first prompt','second prompt'],view:{title:'Regression',sessionId:'regression-session',cwd:'/workspace',totals:{},parts:[],queue:[],threads:[],processes:[],replayComplete:true}};
const png={name:'draft.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZcToAAAAASUVORK5CYII=','base64')};
const emit=(page,message)=>page.evaluate(m=>window.dispatchEvent(new MessageEvent('message',{data:m})),message);
async function open(saved={},sessionId='regression-session',pageOptions={}){
  const page=await browser.newPage({viewport:{width:360,height:700},...pageOptions});page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(saved=>{window.posted=[];window.savedState=saved;window.acquireVsCodeApi=()=>({postMessage:m=>window.posted.push(m),getState:()=>window.savedState,setState:s=>{window.savedState=structuredClone(s);}});},saved);
  await page.goto('data:text/html,'+encodeURIComponent(html(sessionId)));
  await page.waitForFunction(()=>window.posted.some(m=>m.type==='ready'));
  await emit(page,{...state,view:{...state.view,sessionId}});return {page,errors};
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
  await check('thread navigation stays open across parent, child, sibling and nested webview recreation',async()=>{
    const {sessionFamily}=require('../out/session-family.js');
    const rows=[{id:'root',title:'Root'},{id:'parent',title:'Parent',parent_id:'root',source:'fork'},
      {id:'child-a',title:'Child A',parent_id:'parent',source:'fork',updated_at:'2026-10-20T10:00:00Z'},
      {id:'child-b',title:'Child B',parent_id:'parent',source:'fork',updated_at:'2026-10-26T10:00:00Z'},
      {id:'child-idle',title:'Older idle child',parent_id:'parent',source:'fork',updated_at:'2026-10-19T10:00:00Z'},
      {id:'nested',title:'Nested',parent_id:'child-a',source:'fork'}];
    let opened=await open({},'parent'),page=opened.page;
    const errors=opened.errors;
    const snapshot=id=>({...state,view:{...state.view,sessionId:id,title:rows.find(row=>row.id===id).title,...sessionFamily(rows,id,new Map())}});
    await emit(page,snapshot('parent'));
    await page.locator('#threadDetails > summary').click();
    await page.locator('#idleThreadSummary').click();
    await page.locator('#composer').fill('Parent draft');
    async function navigate(id){
      await page.locator('#threadList [data-p="'+id+'"]').click();
      const navigation=await posted(page,'openThread');
      assert.equal(navigation.sessionId,id);assert.equal(navigation.threadNavigation.open,true);
      assert.deepEqual(opened.errors,[]);
      const saved=await page.evaluate(()=>window.savedState);await page.close();
      opened=await open(saved,id);page=opened.page;
      await emit(page,snapshot(id));
      assert(await page.locator('#threadDetails').evaluate(node=>node.open),'thread menu remains open after '+id);
      const selected=page.locator('#threadList [aria-current="true"]');
      assert.equal(await selected.count(),1);assert.equal(await selected.getAttribute('data-p'),id);assert(await selected.isVisible());
      const before=await page.evaluate(()=>window.posted.filter(m=>m.type==='openThread').length);
      await selected.click();assert.equal(await page.evaluate(()=>window.posted.filter(m=>m.type==='openThread').length),before,'selected thread is a navigation no-op');
    }
    await navigate('child-a');
    assert(await page.locator('#parentThreadList [data-p="parent"]').isVisible(),'idle parent is always a visible back link');
    assert(await page.locator('#threadList [data-p="child-b"]').isVisible(),'sibling remains reachable');
    const left=id=>page.locator('#threadList [data-p="'+id+'"] .agent-dot').evaluate(node=>node.getBoundingClientRect().left);
    assert(await left('child-a')>await left('parent'),'children indent beneath parent');
    assert.equal(await left('child-a'),await left('child-b'),'siblings share a level');
    assert(await left('nested')>await left('child-a'),'nested child indents again');
    await navigate('child-b');await navigate('parent');
    assert.equal(await page.locator('#composer').inputValue(),'Parent draft','navigation preserves session-specific drafts');
    await navigate('child-a');await navigate('nested');
    assert(await page.locator('#parentThreadList [data-p="child-a"]').isVisible());
    await navigate('child-a');await navigate('parent');
    await page.locator('#threadDetails > summary').click();
    await page.waitForFunction(()=>window.savedState.threadNavigation?.open===false);
    const saved=await page.evaluate(()=>window.savedState);await page.close();
    opened=await open(saved,'child-b');await emit(opened.page,snapshot('child-b'));
    assert.equal(await opened.page.locator('#threadDetails').evaluate(node=>node.open),false,'an explicit collapse also survives a session switch');
    assert.deepEqual(errors,[]);assert.deepEqual(opened.errors,[]);await opened.page.close();
  });
  await check('deep thread navigation reveals the selection without disturbing later live-update scroll',async()=>{
    const {sessionFamily}=require('../out/session-family.js');
    for(const depth of [5,14])for(const initiallyOpen of [true,false]){
      const id='level-'+depth,rows=Array.from({length:depth+1},(_,index)=>({id:'level-'+index,title:'Thread level '+index,...(index?{parent_id:'level-'+(index-1)}:{})}));
      const {page,errors}=await open({threadNavigation:{open:initiallyOpen,idleOpen:false}},id);
      await page.setViewportSize({width:320,height:500});
      const snapshot={...state,view:{...state.view,sessionId:id,...sessionFamily(rows,id,new Map())}};
      await emit(page,snapshot);
      if(!initiallyOpen)await page.locator('#threadDetails > summary').click();
      await page.waitForFunction(()=>{
        const box=document.querySelector('#threadList').getBoundingClientRect(),row=document.querySelector('#threadList [aria-current="true"]').getBoundingClientRect();
        return row.top>=box.top-1&&row.bottom<=box.bottom+1;
      });
      const parent=await page.locator('#parentThreadList [data-p="level-'+(depth-1)+'"]').boundingBox(),box=await page.locator('#threadList').boundingBox();
      assert(parent.y>=box.y-1&&parent.y+parent.height<=box.y+box.height+1,'the immediate parent stays in view with the selection');
      assert(await page.locator('[aria-current="true"] .activity-name').evaluate(node=>node.getBoundingClientRect().width)>40,'deep indentation must leave a readable thread title');
      await page.locator('#threadList').evaluate(node=>{node.scrollTop=0;});
      await emit(page,{...snapshot,view:{...snapshot.view,currentThread:{...snapshot.view.currentThread,title:'Updated title'}}});
      assert.equal(await page.locator('#threadList').evaluate(node=>node.scrollTop),0,'live updates preserve a deliberately scrolled list');
      assert.deepEqual(errors,[]);await page.close();
    }
  });
  await check('cyclic lineage renders each navigable session only once',async()=>{
    const {sessionFamily}=require('../out/session-family.js'),{page,errors}=await open({threadNavigation:{open:true,idleOpen:true}},'a');
    await emit(page,{...state,view:{...state.view,sessionId:'a',...sessionFamily([{id:'a',parent_id:'b'},{id:'b',parent_id:'a'}],'a',new Map())}});
    const ids=await page.locator('#threadList [data-p]').evaluateAll(nodes=>nodes.map(node=>node.dataset.p));
    assert.deepEqual(ids,['b','a']);assert.equal(await page.locator('[aria-current="true"]').count(),1);
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('an editor spawn link opens the target sidebar menu despite unrelated saved disclosure state',async()=>{
    const source=await open({},'editor-parent');
    await emit(source.page,{...state,view:{...state.view,sessionId:'editor-parent',parts:[{kind:'system',text:'Spawned: Child',childSessionId:'editor-child'}]}});
    assert.equal(await source.page.locator('#threadDetails').evaluate(node=>node.open),false);
    await source.page.locator('.spawn-notice [data-a="openThread"]').click();
    const navigation=await posted(source.page,'openThread');
    assert.deepEqual(navigation,{type:'openThread',sessionId:'editor-child',threadNavigation:{open:true,idleOpen:false}});
    const target=await open({threadNavigation:{open:false,idleOpen:true}},'editor-child');
    await emit(target.page,{type:'threadNavigationRestore',state:navigation.threadNavigation});
    await emit(target.page,{...state,view:{...state.view,sessionId:'editor-child',parentId:'editor-parent',currentThread:{id:'editor-child',title:'Child',relativeDepth:0,status:'idle'}}});
    assert(await target.page.locator('#threadDetails').evaluate(node=>node.open));
    assert.equal(await target.page.locator('#idleThreadDetails').evaluate(node=>node.open),false);
    assert(await target.page.locator('[aria-current="true"]').isVisible());
    assert(await target.page.locator('#parentThreadList [data-p="editor-parent"]').isVisible());
    assert.deepEqual(source.errors,[]);assert.deepEqual(target.errors,[]);await source.page.close();await target.page.close();
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
    assert.deepEqual(await ids('#activeThreadList'),['active-new','waiting','unknown','failed','active-old','idle-latest']);
    assert.deepEqual(await ids('#idleThreadList'),['idle-middle','idle-old']);
    assert.equal(await page.locator('#idleThreadDetails').evaluate(node=>node.open),false);
    assert.equal(await page.locator('#idleThreadList [data-p="idle-middle"]').isVisible(),false);
    for(const id of ['active-new','waiting','unknown','failed','active-old','idle-latest'])assert(await page.locator('#activeThreadList [data-p="'+id+'"]').isVisible(),id+' should remain above the idle fold');
    assert.deepEqual(await ids('#parentThreadList'),['parent'],'parent links are pinned above the sorted roster');
    assert.equal(await page.locator('#threadList .activity-group').count(),0,'relationship headings must not consume the compact list');
    assert.match(await page.locator('#parentThreadList [data-p="parent"]').getAttribute('title'),/Parent/i);
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
    assert.deepEqual(await ids('#activeThreadList'),['waiting','unknown','failed','active-old','active-new']);
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
    assert.deepEqual(await ids('#activeThreadList'),['active-new','waiting','unknown','failed','active-old','idle-latest']);
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
  await check('response actions stay inside the body and remain clickable without hovering thoughts',async()=>{
    const {page,errors}=await open();
    const reasoning='Separate **private thoughts**.',text='A response body that keeps its own hover controls.\n\nMove from this paragraph to each action without leaving the response.';
    const snapshot=reasoning=>({...state,view:{...state.view,parts:[{kind:'assistant',text,reasoning,durable:true,streaming:false,forkTurnId:'hover-turn'}]}});
    const toolbar=page.locator('.msg.assistant .message-actions');
    const opacity=()=>toolbar.evaluate(node=>getComputedStyle(node).opacity);
    await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true});document.execCommand=()=>{window.copiedResponse=document.activeElement.value;return true;};});
    for(const width of [360,1108])for(const thoughtState of ['none','collapsed','expanded']){
      await page.setViewportSize({width,height:700});await emit(page,snapshot(thoughtState==='none'?'':reasoning));
      if(thoughtState!=='none')await page.locator('.reasoning').evaluate((node,expanded)=>{node.open=expanded;},thoughtState==='expanded');
      await page.locator('#composer').focus();await page.mouse.move(0,0);assert.equal(await opacity(),'0');
      for(const action of ['copyReply','forkAtMessage','toggleCheckpointBookmark']){
        await page.locator('#composer').focus();
        const body=await page.locator('.reply-text').boundingBox(),button=page.locator('[data-a="'+action+'"]'),shell=await page.locator('.response-body').boundingBox();
        const start={x:body.x+8,y:body.y+body.height-8};await page.mouse.move(start.x,start.y);
        assert.equal(await opacity(),'1','body hover shows actions');
        const actions=await toolbar.boundingBox(),thought=thoughtState==='none'?null:await page.locator('.reasoning').boundingBox();
        assert(actions.y>=shell.y&&actions.y+actions.height<=shell.y+shell.height,'toolbar stays within the response body, not above the message');
        assert(actions.y+actions.height<=body.y,'toolbar occupies the reserved strip instead of covering reply text');
        if(thought)assert(actions.y>=thought.y+thought.height,'toolbar never overlaps the thought section');
        const target=await button.boundingBox(),end={x:target.x+target.width/2,y:target.y+target.height/2};
        for(let step=1;step<=12;step++){
          await page.mouse.move(start.x+(end.x-start.x)*step/12,start.y+(end.y-start.y)*step/12);
          assert.equal(await opacity(),'1','toolbar remains visible along the pointer path to '+action);
        }
        assert(await button.evaluate(node=>node.contains(document.elementFromPoint(node.getBoundingClientRect().x+node.clientWidth/2,node.getBoundingClientRect().y+node.clientHeight/2))),'action remains hit-testable');
        await page.mouse.click(end.x,end.y);
        if(action==='copyReply')assert.equal(await page.evaluate(()=>window.copiedResponse),(thoughtState==='none'?'':'Thought process\n'+reasoning+'\n\n')+text);
        else{
          assert.equal((await posted(page,action)).turnId,'hover-turn');assert(await button.isDisabled());
          await emit(page,{type:action==='forkAtMessage'?'forkFinished':'bookmarkFinished',turnId:'hover-turn'});assert.equal(await button.isDisabled(),false);
        }
      }
      if(thoughtState!=='none'){
        await page.locator('#composer').focus();await page.locator('.reasoning').hover();assert.equal(await opacity(),'0','thought hover does not show response actions');
        const copy=page.locator('[data-a="copyThinking"]');assert.equal(await copy.evaluate(node=>getComputedStyle(node).opacity),'1');
        await copy.click();assert.equal(await page.evaluate(()=>window.copiedResponse),reasoning);
      }
      await page.locator('[data-a="forkAtMessage"]').focus();await page.mouse.move(0,0);assert.equal(await opacity(),'1','keyboard focus keeps response controls reachable');
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'toolbar does not cause horizontal overflow');
    }
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('response-body actions survive incremental thoughts, short replies and image-only replies',async()=>{
    const {page,errors}=await open();
    const snapshot=part=>({...state,view:{...state.view,running:part.streaming,parts:[{kind:'assistant',durable:!part.streaming,forkTurnId:'body-turn',...part}]}});
    await emit(page,snapshot({text:'A.',reasoning:'',streaming:true}));
    await page.locator('.response-body').evaluate(node=>{window.responseBody=node;});
    for(const part of [
      {text:'A short streaming reply.',reasoning:'A late-arriving thought.',streaming:true},
      {text:'Done.',reasoning:'A late-arriving thought.',streaming:false},
      {text:'Done.',reasoning:'',streaming:false},
      {text:'',reasoning:'',streaming:false,images:[{url:'data:image/png;base64,'+png.buffer.toString('base64')}]}
    ]){
      await emit(page,snapshot(part));
      assert(await page.locator('.response-body').evaluate(node=>node===window.responseBody),'incremental updates retain the response body');
      assert.equal(await page.locator('.response-body .reasoning').count(),0,'thoughts remain outside the response hover region');
      if(part.reasoning)assert(await page.locator('.reasoning').evaluate(node=>node.nextElementSibling.classList.contains('response-body')));
      assert.equal(await page.locator('.caret').count(),part.streaming?1:0);
      assert.equal(await page.locator('[data-a="forkAtMessage"]').count(),part.streaming?0:1);
      await page.locator('#composer').focus();await page.locator('.response-body').hover();
      const toolbar=page.locator('.response-body>.message-actions'),body=await page.locator('.response-body').boundingBox(),actions=await toolbar.boundingBox();
      assert.equal(await toolbar.evaluate(node=>getComputedStyle(node).opacity),'1');
      assert(actions.y>=body.y&&actions.y+actions.height<=body.y+body.height,'controls fit inside even short and image-only response bodies');
      await page.locator('[data-a="copyReply"]').click();
    }
    assert.equal(await page.locator('.reply-images img').evaluate(node=>node.complete&&node.naturalWidth>0),true);
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('code-first replies keep code copy and response actions independently reachable by pointer, keyboard and touch',async()=>{
    for(const hasTouch of [false,true]){
      const {page,errors}=await open({},'regression-session',{hasTouch});
      await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true});document.execCommand=()=>{window.copiedResponse=document.activeElement.value;return true;};});
      for(const width of [360,1108])for(const quoteDepth of [0,1,2])for(const prose of ['', '\n\nThe answer is ready.']){
        const prefix='> '.repeat(quoteDepth),text=['```ts','const answer = 42;','```'].map(line=>prefix+line).join('\n')+prose;
        await page.setViewportSize({width,height:700});
        await emit(page,{...state,view:{...state.view,parts:[{kind:'assistant',text,reasoning:'',durable:true,streaming:false,forkTurnId:'code-turn'}]}});
        const toolbar=page.locator('.message-actions'),codeCopy=page.locator('.codeblock-copy');
        await page.locator('#composer').focus();
        if(!hasTouch)await page.locator('.codeblock').hover();
        assert.equal(await toolbar.evaluate(node=>getComputedStyle(node).opacity),'1','code hover also exposes response actions');
        assert.equal(await codeCopy.evaluate(node=>getComputedStyle(node).opacity),'1');
        const actions=await toolbar.boundingBox(),head=await page.locator('.codeblock-head').boundingBox(),body=await page.locator('.response-body').boundingBox();
        assert(actions.y>=body.y&&actions.y+actions.height<=head.y,'response actions stay inside the body without covering code controls');
        const codeTarget=await codeCopy.boundingBox();
        assert(await codeCopy.evaluate(node=>{const b=node.getBoundingClientRect();return [2,b.width/2,b.width-2].every(x=>[2,b.height/2,b.height-2].every(y=>node.contains(document.elementFromPoint(b.x+x,b.y+y))));}),'the entire code copy button is free of overlapping response actions');
        const actionCount=await page.evaluate(()=>window.posted.filter(m=>m.type==='forkAtMessage'||m.type==='toggleCheckpointBookmark').length);
        for(const offset of [2,codeTarget.height/2,codeTarget.height-2]){
          const x=codeTarget.x+codeTarget.width/2,y=codeTarget.y+offset;
          await page.evaluate(()=>{window.copiedResponse=null;});
          if(hasTouch)await page.touchscreen.tap(x,y);else await page.mouse.click(x,y);
          assert.equal(await page.evaluate(()=>window.copiedResponse),'const answer = 42;');
        }
        assert.equal(await page.evaluate(()=>window.posted.filter(m=>m.type==='forkAtMessage'||m.type==='toggleCheckpointBookmark').length),actionCount,'code copy never triggers a response action');
        for(const action of ['copyReply','forkAtMessage','toggleCheckpointBookmark']){
          await page.locator('#composer').focus();
          const button=page.locator('[data-a="'+action+'"]'),target=await button.boundingBox(),end={x:target.x+target.width/2,y:target.y+target.height/2};
          if(hasTouch)await page.touchscreen.tap(end.x,end.y);
          else{
            const content=await page.locator(prose?'.reply-text p':'.codeblock pre').boundingBox(),start={x:content.x+8,y:content.y+content.height/2};
            await page.mouse.move(start.x,start.y);
            for(let step=1;step<=12;step++){
              await page.mouse.move(start.x+(end.x-start.x)*step/12,start.y+(end.y-start.y)*step/12);
              assert.equal(await toolbar.evaluate(node=>getComputedStyle(node).opacity),'1','actions stay visible while crossing a code block to '+action);
            }
            await page.mouse.click(end.x,end.y);
          }
          if(action==='copyReply')assert.equal(await page.evaluate(()=>window.copiedResponse),text);
          else{
            assert.equal((await posted(page,action)).turnId,'code-turn');assert(await button.isDisabled());
            await emit(page,{type:action==='forkAtMessage'?'forkFinished':'bookmarkFinished',turnId:'code-turn'});assert.equal(await button.isDisabled(),false);
          }
        }
        await page.locator('[data-a="forkAtMessage"]').focus();await page.mouse.move(0,0);
        assert.equal(await toolbar.evaluate(node=>getComputedStyle(node).opacity),'1','keyboard focus keeps response controls reachable over code');
      }
      assert.deepEqual(errors,[]);await page.close();
    }
  });
  await check('response controls never cover clickable reply content in any first-block shape',async()=>{
    const {page,errors}=await open();
    const wideImage='data:image/svg+xml;utf8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300"><rect width="900" height="300" fill="#888"/></svg>');
    const shapes=[
      ['link on the first line',{text:'Read the [reference](https://example.com/reference) before changing the retention window, the retry budget or the cache.'},true],
      ['rule then a code fence',{text:'---\n\n```ts\nconst a = 1;\n```'},true],
      ['heading first',{text:'# Heading\n\nBody text below the heading.'}],
      ['table first',{text:'| left | right |\n| --- | --- |\n| 1 | 2 |'}],
      ['list then a fence',{text:'- first item\n\n  ```ts\n  const b = 2;\n  ```'},true],
      ['quoted code',{text:'> ```ts\n> const c = 3;\n> ```'},true],
      ['plain prose',{text:'A plain reply whose first line runs to the right edge of a narrow panel and keeps going.'}],
      ['image only',{text:'',images:[{url:wideImage}]},true]
    ];
    for(const width of [360,1108])for(const [name,part,clickable] of shapes){
      await page.setViewportSize({width,height:700});
      await emit(page,{...state,view:{...state.view,parts:[{kind:'assistant',reasoning:'',durable:true,streaming:false,forkTurnId:'shape-turn',...part}]}});
      await page.locator('#composer').focus();
      // Hover the code block when there is one so its copy button is pointer-enabled, as it is in real use.
      await (await page.locator('.response-body .codeblock').count()?page.locator('.response-body .codeblock').first():page.locator('.response-body')).hover();
      const report=await page.evaluate(()=>{
        const body=document.querySelector('.response-body'),bar=body.querySelector(':scope>.message-actions'),barRect=bar.getBoundingClientRect(),bodyRect=body.getBoundingClientRect();
        const covered=[],blocked=[],unreachable=[];let examined=0;
        for(const el of body.querySelectorAll('a,button,summary,img,[tabindex="0"]')){
          if(bar.contains(el))continue;
          const r=el.getBoundingClientRect();if(!r.width||!r.height)continue;
          if(r.top<0||r.bottom>innerHeight||r.left<0||r.right>innerWidth)continue;
          examined++;
          const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
          if(!el.contains(hit))covered.push((el.className||el.tagName)+' receives '+(hit?hit.className||hit.tagName:'nothing'));
          if(r.top<barRect.bottom&&barRect.top<r.bottom&&r.left<barRect.right&&barRect.left<r.right)blocked.push(el.className||el.tagName);
        }
        for(const el of bar.querySelectorAll('button')){
          const r=el.getBoundingClientRect();
          if(!el.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)))unreachable.push(el.dataset.a);
        }
        return {covered,blocked,unreachable,examined,inside:barRect.top>=bodyRect.top-.5&&barRect.bottom<=bodyRect.bottom+.5,strip:getComputedStyle(body).paddingTop};
      });
      assert(report.inside,name+': controls stay inside the response body');
      assert.equal(report.strip,'20px',name+': the control strip is reserved rather than overlapping content');
      assert.deepEqual(report.covered,[],name+': every clickable element in the reply receives its own click');
      assert.deepEqual(report.blocked,[],name+': the control strip overlaps no clickable element');
      assert.deepEqual(report.unreachable,[],name+': every response control is hit-testable');
      if(clickable)assert(report.examined>0,name+': the shape really renders clickable content to protect');
    }
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('reply clicks reach their own control after a leading rule, a first-line link and a wide image',async()=>{
    const {page,errors}=await open();
    await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true});document.execCommand=()=>{window.copiedResponse=document.activeElement.value;return true;};});
    const wideImage='data:image/svg+xml;utf8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300"><rect width="900" height="300" fill="#888"/></svg>');
    const hijacks=()=>page.evaluate(()=>window.posted.filter(m=>m.type==='forkAtMessage'||m.type==='toggleCheckpointBookmark').length);
    for(const width of [360,1108]){
      await page.setViewportSize({width,height:700});
      await emit(page,{...state,view:{...state.view,parts:[{kind:'assistant',text:'---\n\n```ts\nconst a = 1;\n```',reasoning:'',durable:true,streaming:false,forkTurnId:'rule-turn'}]}});
      await page.locator('.codeblock').hover();
      const copy=page.locator('.codeblock-copy'),target=await copy.boundingBox();
      for(const offset of [2,target.height/2,target.height-2]){
        await page.evaluate(()=>{window.copiedResponse=null;});
        await page.mouse.click(target.x+target.width/2,target.y+offset);
        assert.equal(await page.evaluate(()=>window.copiedResponse),'const a = 1;','code copy below a leading rule copies code at offset '+offset);
      }
      assert.equal(await hijacks(),0,'code copy below a leading rule never forks or bookmarks');
      await emit(page,{...state,view:{...state.view,parts:[{kind:'assistant',text:'Read the [reference](https://example.com/reference) before changing the retention window, the retry budget or the cache.',reasoning:'',durable:true,streaming:false,forkTurnId:'link-turn'}]}});
      await page.locator('.reply-text').hover();
      const link=await page.locator('.reply-text a').boundingBox();
      await page.mouse.click(link.x+link.width/2,link.y+link.height/2);
      assert.equal((await posted(page,'openExternal')).url,'https://example.com/reference','a first-line link opens instead of forking the conversation');
      assert.equal(await hijacks(),0,'a first-line link never forks or bookmarks');
      await emit(page,{...state,view:{...state.view,parts:[{kind:'assistant',text:'',reasoning:'',durable:true,streaming:false,images:[{url:wideImage}]}]}});
      await page.locator('.response-body').hover();
      const image=await page.locator('.message-image').boundingBox();
      assert(image.width>200,'the image reaches across the reply at '+width+'px, width '+image.width);
      await page.mouse.click(image.x+image.width-6,image.y+6);
      assert.equal(await page.locator('#imagePreview').evaluate(node=>!node.classList.contains('hidden')),true,'the top corner of a wide image still opens the preview');
      await page.locator('#closeImagePreview').click();
      assert.equal(await hijacks(),0,'an image corner never forks or bookmarks');
    }
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('a thought-only response body keeps its controls inside and off the next message',async()=>{
    const {page,errors}=await open({},'regression-session',{hasTouch:true});
    for(const width of [360,1108]){
      await page.setViewportSize({width,height:700});
      await emit(page,{...state,view:{...state.view,running:true,parts:[
        {kind:'assistant',text:'',reasoning:'Thinking it through.',durable:false,streaming:true},
        {kind:'user',text:'The next message keeps its own first line.'}]}});
      const bar=page.locator('.response-body>.message-actions');
      assert.equal(await bar.evaluate(node=>getComputedStyle(node).opacity),'1','touch shows response controls without a hover');
      const geo=await page.evaluate(()=>{
        const body=document.querySelector('.response-body'),bar=body.querySelector(':scope>.message-actions');
        const b=body.getBoundingClientRect(),r=bar.getBoundingClientRect();
        const next=document.querySelector('.msg.user .bubble'),n=next.getBoundingClientRect();
        const hit=document.elementFromPoint(n.left+n.width/2,n.top+8);
        return {bodyHeight:b.height,inside:r.top>=b.top-.5&&r.bottom<=b.bottom+.5,nextClear:hit?next.contains(hit):false,hit:hit?String(hit.className||hit.tagName):'nothing'};
      });
      assert(geo.bodyHeight>=20,'the reserved strip gives an otherwise empty body height: '+geo.bodyHeight);
      assert(geo.inside,'controls stay inside an empty response body');
      assert(geo.nextClear,'controls never hang over the next message, they hit '+geo.hit);
    }
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('user message controls stay reachable and yield to code copy',async()=>{
    const {page,errors}=await open();
    await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true});document.execCommand=()=>{window.copiedResponse=document.activeElement.value;return true;};});
    const text='Check this paragraph first.\n\n```ts\nconst u = 9;\n```';
    for(const width of [360,1108]){
      await page.setViewportSize({width,height:700});
      await emit(page,{...state,view:{...state.view,parts:[{kind:'user',text,durable:true}]}});
      const bar=page.locator('.msg.user .message-actions'),copy=page.locator('[data-a="copyUser"]');
      await page.locator('#composer').focus();await page.mouse.move(0,0);
      assert.equal(await bar.evaluate(node=>getComputedStyle(node).opacity),'0','idle user controls stay hidden');
      await page.locator('.msg.user .md>p').hover();
      assert.equal(await bar.evaluate(node=>getComputedStyle(node).opacity),'1','hovering the user message shows its controls');
      assert(await copy.evaluate(node=>{const r=node.getBoundingClientRect();return node.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));}),'the user copy button is hit-testable');
      await page.evaluate(()=>{window.copiedResponse=null;});
      await copy.click();
      assert.equal(await page.evaluate(()=>window.copiedResponse),text,'user copy copies the message');
      await page.locator('.msg.user .codeblock').hover();
      assert.equal(await bar.evaluate(node=>getComputedStyle(node).opacity),'0','hovering code in a user message yields to the code copy button');
      const codeCopy=page.locator('.msg.user .codeblock-copy');
      assert.equal(await codeCopy.evaluate(node=>getComputedStyle(node).opacity),'1');
      await page.evaluate(()=>{window.copiedResponse=null;});
      const box=await codeCopy.boundingBox();await page.mouse.click(box.x+box.width/2,box.y+2);
      assert.equal(await page.evaluate(()=>window.copiedResponse),'const u = 9;','code copy inside a user message still copies code');
    }
    assert.deepEqual(errors,[]);await page.close();
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
  await check('compact header gives space to the conversation without clipping titles or controls',async()=>{
    const {page,errors}=await open();
    await emit(page,{...state,view:{...state.view,title:'Review and perfect VS Code extension '+('with a long conversation title '.repeat(8)),parts:[{kind:'assistant',text:'The conversation keeps the available screen space.',streaming:false}]}});
    for(const viewport of [{width:1108,height:650},{width:360,height:700},{width:320,height:500}]){
      await page.setViewportSize(viewport);
      const metrics=await page.evaluate(()=>{
        const header=document.getElementById('topbar'),title=document.getElementById('title'),img=header.querySelector('.brand img'),style=getComputedStyle(header);
        const controls=[title,...header.querySelectorAll('.icon-btn')].map(node=>{const box=node.getBoundingClientRect();return {width:box.width,height:box.height,left:box.left,right:box.right,top:box.top,bottom:box.bottom};});
        return {height:header.getBoundingClientRect().height,paddingTop:parseFloat(style.paddingTop),paddingBottom:parseFloat(style.paddingBottom),avatar:img.getBoundingClientRect().width,titleFont:parseFloat(getComputedStyle(title).fontSize),brandFont:parseFloat(getComputedStyle(header.querySelector('.brand')).fontSize),truncated:title.scrollWidth>title.clientWidth,overflow:document.documentElement.scrollWidth>innerWidth,controls};
      });
      assert(metrics.height<=34,'header should reclaim at least 20px of conversation height');
      assert(metrics.paddingTop<=3&&metrics.paddingBottom<=3,'header vertical padding should stay tight at every width');
      assert.equal(metrics.avatar,22);assert.equal(metrics.titleFont,12);assert.equal(metrics.brandFont,12);
      assert.equal(metrics.truncated,true,'long titles should truncate rather than enlarge the header');
      assert.equal(metrics.overflow,false);
      for(const control of metrics.controls){assert(control.width>=24&&control.height>=24,'header controls retain usable targets');assert(control.left>=0&&control.right<=viewport.width);assert(control.top>=0&&control.bottom<=metrics.height);}
      await page.locator('#title').click();
      assert.equal(await page.locator('#titleInput').isVisible(),true);
      const editing=await page.locator('#topbar').boundingBox();assert.equal(editing.height,metrics.height,'renaming must not make the compact header jump');
      await page.locator('#titleInput').press('Escape');
      assert.equal(await page.locator('#title').evaluate(node=>node===document.activeElement),true);
      await page.locator('#sessBtn').click();
      const picker=await page.locator('#sessionPicker').boundingBox();assert(picker.y>=metrics.height-5&&picker.y<=metrics.height+4,'session picker stays anchored to the header padding box');assert(picker.x>=0&&picker.x+picker.width<=viewport.width);
      await page.locator('#sessionSearch').press('Escape');
      await page.locator('#menuWrap > summary').click();
      const menu=await page.locator('#menuWrap .menu').boundingBox();assert(menu.y>=metrics.height-4&&menu.y<=metrics.height+6,'actions menu stays anchored to the smaller header');assert(menu.x>=0&&menu.x+menu.width<=viewport.width);
      await page.locator('#menuWrap > summary').press('Escape');
      assert.equal(await page.locator('#menuWrap').evaluate(node=>node.open),false);
    }
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('status and usage stay below the input and actions at panel and sidebar widths',async()=>{
    const {page,errors}=await open();
    const view={...state.view,standby:false,totals:{total:29500000,costKnown:true,costUsd:11.6276},contextUsage:{input:23900}};
    for(const viewport of [{width:1108,height:650},{width:360,height:700},{width:320,height:500}]){
      await page.setViewportSize(viewport);
      for(const running of [true,false]){
        await emit(page,{...state,view:{...view,running}});
        await page.locator('#composer').fill(running?'A draft\nwith multiple lines\nand more room to type.':'A short draft');
        const metrics=await page.evaluate(()=>{
          const box=id=>document.getElementById(id).getBoundingClientRect(),bar=box('composerBar'),status=box('statusLine'),hint=box('composerHint');
          return {barBottom:bar.bottom,statusTop:status.top,statusBottom:status.bottom,hintTop:hint.top,hintVisible:getComputedStyle(document.getElementById('composerHint')).display!=='none',ordered:document.getElementById('composerBar').nextElementSibling.id==='statusLine',overflow:document.documentElement.scrollWidth>innerWidth};
        });
        assert(metrics.ordered,'DOM order must match the visual order');
        assert(metrics.statusTop>=metrics.barBottom,'status must be below the whole input box, including action buttons');
        assert(metrics.statusBottom<=viewport.height,'the row remains visible without page scrolling');
        if(metrics.hintVisible)assert(metrics.hintTop>=metrics.statusBottom,'the keyboard hint stays last');
        assert.equal(metrics.overflow,false);
        assert.equal(await page.locator('#statusLine .connection').textContent(),running?'Working':'Ready');
        assert((await page.locator('#statusLine').textContent()).includes('Saved · ctx 23.9 K · 29.5 M tokens · $11.6276'));
        assert((await page.locator('#statusLine>span').last().getAttribute('title')).includes('29,500,000'));
        assert.equal(await page.locator('#cancelBtn').isVisible(),running);
      }
    }
    assert.deepEqual(errors,[]);await page.close();
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
  await check('reconnecting processes retain output but need a fresh running receipt before Stop returns',async()=>{
    const {SessionController}=require('../out/manager.js');
    const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
    const children=[];
    const cli={spawnRpc(){const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;children.push(child);return child;}};
    const api={sessionDetail:async()=>({session_id:'regression-session',cwd:'/workspace'}),header:async()=>({}),target:async()=>({}),sessions:async()=>[]};
    const controller=new SessionController(cli,{log(){}},api,'/workspace','regression-session');
    const {page,errors}=await open();
    const frame=value=>children.at(-1).stdout.write(JSON.stringify(value)+'\n');
    const show=()=>emit(page,{...state,connection:controller.rpc.connectionState,view:controller.store.view()});
    try{
      controller.connect();
      frame({type:'session_stream_resumed',session_id:'regression-session',cursor:1,admission_state:'ready',replay_chunk_final:true,accumulated_frames:[]});
      frame({type:'session_background_process_updated',session_id:'regression-session',process:{exec_id:7,command:'retained process',status:'running',tail:'last observed output'}});
      await show();await page.locator('#processDetails > summary').click();await page.locator('.activity-process > summary').click();
      assert(await page.locator('.process-stop').isVisible());
      children.at(-1).emit('close',1,null);await show();
      assert.equal(await page.locator('.process-stop').isVisible(),false);
      assert((await page.locator('.process-status').textContent()).includes('unknown'));
      assert.equal(await page.locator('.process-output').textContent(),'last observed output');
      controller.connect();
      frame({type:'session_stream_resumed',session_id:'regression-session',cursor:1,resumed_after:1,admission_state:'ready',replay_chunk_final:true,accumulated_frames:[]});
      await show();assert.equal(await page.locator('.process-stop').isVisible(),false,'a cursor replay alone does not confirm a process is still alive');
      frame({type:'session_background_process_updated',session_id:'regression-session',process:{exec_id:7,command:'retained process',status:'running'}});
      await show();assert(await page.locator('.process-stop').isVisible());assert.equal(await page.locator('.process-output').textContent(),'last observed output');
      assert.deepEqual(errors,[]);
    }finally{controller.dispose();await page.close();}
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
  await check('eval cards use compact headers and spacing without losing expandable contents',async()=>{
    const {page,errors}=await open();
    await emit(page,{...state,view:{...state.view,parts:[159,192].map((durationMs,i)=>({kind:'tool',call:{callId:'compact-eval-'+i,name:'eval',arguments:'(+ 1 2)',result:'3',done:true,durationMs}}))}});
    const cards=page.locator('.tool');assert.equal(await cards.count(),2);
    for(const card of await cards.all()){
      const size=await card.evaluate(node=>({height:node.getBoundingClientRect().height,font:parseFloat(getComputedStyle(node.querySelector('summary')).fontSize),margin:parseFloat(getComputedStyle(node).marginBottom)}));
      assert(size.height<=30,'collapsed eval card should be compact');assert(size.font<=11,'eval header text should be smaller');assert(size.margin<=10,'eval cards should not leave large gaps');
    }
    const first=cards.first();await first.locator(':scope > summary').focus();await page.keyboard.press('Enter');
    assert(await first.evaluate(node=>node.open));assert.equal(await first.locator('.tool-io').first().textContent(),'(+ 1 2)');assert.equal(await first.locator('.tool-io').last().textContent(),'3');
    await page.keyboard.press('Enter');assert.equal(await first.evaluate(node=>node.open),false);
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('expanded eval input and output match compact headers without clipping content',async()=>{
    const {page,errors}=await open();
    const input=JSON.stringify({form:';; Inspect the current state\n(list '+ '"retained argument" '.repeat(40)+')'});
    const output='Recorded result: '+ 'retained output '.repeat(40)+'\nSecond result line.\n';
    const metadata={snippet:{note:'Inspect the current state without changing it.'},status:'done'};
    await emit(page,{...state,view:{...state.view,parts:[
      {kind:'tool',call:{callId:'expanded-eval',name:'eval',arguments:input,result:output,metadata,done:true,durationMs:21}},
      {kind:'tool',call:{callId:'failed-eval',name:'eval',arguments:'(error "Retained error")',result:'Retained error',done:true,failed:true}},
    ]}});
    const card=page.locator('.tool').first();await card.locator(':scope > summary').click();
    const details=card.locator('.tool-metadata');await details.locator('summary').click();
    const failed=page.locator('.tool').last();await failed.locator(':scope > summary').click();
    for(const width of [360,960]){
      await page.setViewportSize({width,height:760});
      await page.evaluate(()=>{document.documentElement.style.setProperty('--vscode-font-size','16px');document.documentElement.style.setProperty('--vscode-editor-font-size','24px');});
      const blocks=await page.locator('pre.tool-io').evaluateAll(nodes=>nodes.map(node=>{const css=getComputedStyle(node);return {font:parseFloat(css.fontSize),line:parseFloat(css.lineHeight),paddingTop:parseFloat(css.paddingTop),paddingLeft:parseFloat(css.paddingLeft),overflow:css.overflowX,scrollable:node.scrollWidth>node.clientWidth};}));
      for(const block of blocks){
        assert.equal(block.font,11,'eval input, output and result details must match the compact header font');
        assert(block.line<=16.5,'eval blocks should retain compact readable line spacing');
        assert(block.paddingTop<=6&&block.paddingLeft<=8,'eval boxes should not add oversized insets');
        assert.equal(block.overflow,'auto','long lines must remain scrollable');
      }
      assert(blocks[0].scrollable,'long input should scroll inside its box');
      assert.equal(await details.locator('summary').evaluate(node=>parseFloat(getComputedStyle(node).fontSize)),11);
      assert(await page.locator('.tool-sec').first().evaluate(node=>parseFloat(getComputedStyle(node).paddingTop)<=6));
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'expanded eval content must not widen the page');
    }
    assert.equal(await card.locator('.tool-sec pre').first().textContent(),input);
    assert.equal(await card.locator('.tool-sec pre').last().textContent(),output);
    assert.equal(await details.locator('pre').textContent(),JSON.stringify(metadata,null,2));
    assert.equal(await failed.locator('.tool-label').last().textContent(),'Error');
    assert.equal(await failed.locator('.tool-io').last().textContent(),'Retained error');
    assert.deepEqual(errors,[]);await page.close();
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
  await check('composer uses available panel width with small balanced gutters at every size',async()=>{
    const {page,errors}=await open();
    const draft='Use the available width while preserving the draft and its attached image. '.repeat(6);
    await page.locator('#composer').fill(draft);await page.locator('#imageInput').setInputFiles(png);
    await page.waitForFunction(()=>document.querySelectorAll('#attachments img').length===1);
    for(const width of [320,360,960,1440]){
      await page.setViewportSize({width,height:760});
      const size=await page.evaluate(()=>{
        const box=document.querySelector('#composerBar').getBoundingClientRect(),input=document.querySelector('#composer').getBoundingClientRect(),status=document.querySelector('#statusLine').getBoundingClientRect();
        return {left:box.left,right:innerWidth-box.right,width:box.width,inputWidth:input.width,inputLeft:input.left,inputRight:input.right,boxRight:box.right,statusLeft:status.left,statusRight:status.right,overflow:document.documentElement.scrollWidth>innerWidth};
      });
      assert(size.left>=6&&size.left<=10,'composer left gutter should remain small, got '+size.left+'px');
      assert(Math.abs(size.left-size.right)<1,'composer gutters should be balanced');
      assert(size.width>=width-20,'composer must not retain a fixed maximum width');
      assert(size.inputWidth>=size.width-30,'text entry should use the wider composer');
      assert(size.inputLeft>size.left&&size.inputRight<size.boxRight,'text entry must retain its internal padding');
      assert.equal(size.statusLeft,size.left);assert.equal(size.statusRight,size.boxRight);
      assert.equal(size.overflow,false,'wider composer must not cause horizontal page overflow');
      assert.equal(await page.locator('#composer').inputValue(),draft);assert.equal(await page.locator('#attachments img').count(),1);
      for(const id of ['attachBtn','modelBtn','effortBtn','sendBtn'])assert(await page.locator('#'+id).isVisible());
    }
    assert.deepEqual(errors,[]);await page.close();
  });
  assert.deepEqual(failures,[],'Chromium regressions failed');
}finally{await browser.close();}
