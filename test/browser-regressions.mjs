// Optional real Chromium regressions; use the same PLAYWRIGHT_PATH as browser-smoke.mjs.
import assert from 'node:assert/strict';
import {createRequire,Module} from 'node:module';
import fs from 'node:fs';
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
    await emit(page,{...state,view:{...state.view,totals:{input:99000,output:12000},contextUsage:{input:1000,cached:2000,cacheWrite:300}}});
    assert((await page.locator('#statusLine').textContent()).includes('12000 out / ctx 3.3 K'));
    assert((await page.locator('#statusLine>span').last().getAttribute('title')).includes('3,300'));
    await page.close();
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
  assert.deepEqual(failures,[],'Chromium regressions failed');
}finally{await browser.close();}
