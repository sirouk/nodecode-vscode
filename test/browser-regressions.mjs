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
  assert.deepEqual(failures,[],'Chromium regressions failed');
}finally{await browser.close();}
