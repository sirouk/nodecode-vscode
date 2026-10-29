// Chromium regressions for the bounded scrollback window: reopen cost, seamless
// scroll back, and the guarantee that an idle tick does no transcript work.
// Uses the same PLAYWRIGHT_PATH convention as browser-smoke.mjs.
import assert from 'node:assert/strict';
import {createRequire,Module} from 'node:module';
import fs from 'node:fs';
const require=createRequire(import.meta.url),load=Module._load;
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
Module._load=function(name,...args){return name==='vscode'?{Uri:{joinPath:()=>({toString:()=>''})}}:load.call(this,name,...args);};
const {SessionPanel}=require('../out/panel.js');Module._load=load;
const panel=Object.create(SessionPanel.prototype);
panel.controller={sessionId:'window-session'};
panel.panel={webview:{cspSource:'https://webview.local'}};
panel.markUri='data:image/svg+xml;base64,'+fs.readFileSync(new URL('../media/icon.svg',import.meta.url)).toString('base64');
panel.markdownUri='https://webview.local/markdown.js';
const html=sessionId=>{panel.controller={sessionId};return panel.html().replace(/<script nonce="([^"]+)" src="[^"]+"><\/script>/,(_,nonce)=>'<script nonce="'+nonce+'">'+fs.readFileSync(new URL('../out/markdown.js',import.meta.url),'utf8')+'</script>');};
const browser=await chromium.launch({headless:true});
const state={type:'state',connection:'connected',attempts:0,history:['earlier prompt'],view:{title:'Window',sessionId:'window-session',cwd:'/workspace',totals:{},parts:[],queue:[],threads:[],processes:[],replayComplete:true}};
const TAIL=240;
// A long thread of plain text turns, shaped like the harness fixture.
function thread(turns){
  const words=n=>Array.from({length:n},(_,k)=>('w'+(k%97))).join(' ');
  const out=[];
  for(let i=0;i<turns;i++){
    out.push({kind:'user',text:'Prompt '+i+': '+words(60),turnNumber:i});
    out.push({kind:'assistant',text:'Reply '+i+': '+words(300),reasoning:words(200),turnNumber:i,streaming:false,durable:true,forkTurnId:'turn-'+i});
    out.push({kind:'tool',call:{callId:'c'+i+'a',name:'read_file',arguments:JSON.stringify({path:'src/file'+i+'.ts'}),result:words(120),done:true,status:'done',durationMs:12,metadata:{}},turnNumber:i});
    out.push({kind:'tool',call:{callId:'c'+i+'b',name:'edit_file',arguments:JSON.stringify({path:'src/file'+i+'.ts',old:words(20),new:words(20)}),result:'ok',done:true,status:'done',durationMs:8,metadata:{}},turnNumber:i});
    out.push({kind:'system',text:'Turn '+i+' completed.',level:'info'});
  }
  return out;
}
const emit=(page,message)=>page.evaluate(m=>window.dispatchEvent(new MessageEvent('message',{data:m})),message);
async function open(saved={},parts=thread(500),sessionId='window-session'){
  const page=await browser.newPage({viewport:{width:1200,height:900}});page.setDefaultTimeout(8000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(saved=>{window.posted=[];window.savedState=saved;window.acquireVsCodeApi=()=>({postMessage:m=>window.posted.push(m),getState:()=>window.savedState,setState:s=>{window.savedState=structuredClone(s);}});},saved);
  await page.goto('data:text/html,'+encodeURIComponent(html(sessionId)));
  await page.waitForFunction(()=>window.posted.some(m=>m.type==='ready'));
  await page.evaluate(p=>{window.__all=p;},parts);
  // The extension answers a scroll-back request with the slice just before the cache.
  await page.evaluate(tail=>{
    window.__ship=(extra)=>{const all=window.__all,start=Math.max(0,all.length-tail);
      window.dispatchEvent(new MessageEvent('message',{data:{...window.__state,view:{...window.__state.view,parts:all.slice(start),partsStart:start,partsTotal:all.length,...extra}}}));};
    window.__serve=()=>{const req=window.posted.filter(m=>m.type==='requestParts'&&!m.__served)[0];if(!req)return false;req.__served=true;
      const all=window.__all,end=Math.max(0,Math.min(req.before,all.length)),from=Math.max(0,end-Math.min(400,Math.max(1,req.limit||200)));
      window.dispatchEvent(new MessageEvent('message',{data:{type:'partsWindow',requestId:req.requestId,sessionId:window.__state.view.sessionId,start:from,total:all.length,parts:all.slice(from,end)}}));return true;};
    window.__state=window.__state||null;
  },TAIL);
  await page.evaluate(s=>{window.__state=s;},state);
  await page.evaluate(()=>window.__ship());
  await page.waitForTimeout(120);
  return {page,errors,parts};
}
const rows=page=>page.evaluate(()=>document.getElementById('transcript').children.length);
const nodes=page=>page.evaluate(()=>document.getElementById('transcript').querySelectorAll('*').length);
const firstIndex=page=>page.evaluate(()=>document.querySelector('#transcript').firstElementChild._partIndex);
const lastIndex=page=>page.evaluate(()=>document.querySelector('#transcript').lastElementChild._partIndex);
const box=page=>page.evaluate(()=>{const b=document.getElementById('scroll');return{top:b.scrollTop,height:b.scrollHeight,client:b.clientHeight};});
const draft=page=>page.evaluate(()=>window.savedState.sessions?.['window-session']);
// One upward gesture: the panel may extend the window from what it already
// holds, or ask the extension for the next slice; wait until that settles.
async function gestureUp(page){
  const before=await rows(page);
  await page.evaluate(()=>{const b=document.getElementById('scroll');b.scrollTop=60;b.dispatchEvent(new Event('scroll'));});
  for(let k=0;k<40;k++){
    await page.waitForTimeout(16);
    if(await page.evaluate(()=>window.__serve())){await page.waitForTimeout(16);continue;}
    const pending=await page.evaluate(()=>window.posted.some(m=>m.type==='requestParts'&&!m.__served));
    if(!pending&&await rows(page)>=before)break;
  }
}
async function scrollBack(page,times=1){for(let i=0;i<times;i++)await gestureUp(page);}
const failures=[];
async function check(name,run){try{await run();console.log('PASS '+name);}catch(error){failures.push(name);console.error('FAIL '+name+'\n'+error.stack);}}
try{
  await check('a reopened long thread shows only the last bunch and lands at the bottom',async()=>{
    // Saved deep in the top of a 2500-part thread: the reader asked for the whole
    // history last time, and reopening must not rebuild it.
    const {page,errors}=await open({sessions:{'window-session':{visibleStart:0,scrollTop:900000,historyExpanded:true,thread:'window-session'}},'thread':'window-session'});
    assert.equal(await rows(page),160,'reopen renders the bounded window, not the whole transcript');
    assert(await nodes(page)<3000,'rendered DOM stays proportional to the window');
    assert.equal(await firstIndex(page),2340,'the window ends at the newest part');
    const b=await box(page);
    assert(b.height-b.top-b.client<40,'reopen lands at the latest content');
    assert(await page.locator('#historyEarlier').isVisible(),'older history stays reachable');
    assert.equal((await draft(page)).visibleStart,2340,'the window position is what gets saved');
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('scrolling back loads older parts seamlessly and keeps the reading position',async()=>{
    const {page,errors}=await open();
    const start=await firstIndex(page);
    await gestureUp(page);
    // Take the anchor at the moment of the next load, inside the same task: jumping
    // to the top legitimately moves everything else, so it cannot be the reference.
    await page.evaluate(()=>{
      const box=document.getElementById('scroll');
      box.scrollTop=200;
      const top=box.getBoundingClientRect().top;
      const anchor=Array.from(document.getElementById('transcript').children).find(n=>n.getBoundingClientRect().bottom>top);
      window.__anchor={p:anchor._partIndex,top:Math.round(anchor.getBoundingClientRect().top)};
      window.__rows=document.getElementById('transcript').children.length;
      box.dispatchEvent(new Event('scroll'));
    });
    for(let k=0;k<40;k++){
      await page.waitForTimeout(16);
      if(await page.evaluate(()=>window.__serve()))continue;
      if(await page.evaluate(()=>document.getElementById('transcript').children.length>window.__rows))break;
    }
    const requests=await page.evaluate(()=>window.posted.filter(m=>m.type==='requestParts').map(m=>({before:m.before,limit:m.limit})));
    assert(requests.length,'scrolling near the top asks the extension for the older slice');
    assert(requests[0].before<=start,'it asks for a slice older than the shipped tail');
    assert(requests.every(r=>r.limit>0&&r.limit<=400),'every request is bounded');
    assert(requests.every((r,i)=>i===0||r.before<requests[i-1].before),'each answer moves the cache further back');
    const now=await firstIndex(page);
    assert(now<start,'older parts joined the window');
    assert(await rows(page)>160,'the window grew to hold them');
    const held=await page.evaluate(()=>{const anchor=Array.from(document.getElementById('transcript').children).find(n=>n._partIndex===window.__anchor.p);return{found:!!anchor,top:anchor?Math.round(anchor.getBoundingClientRect().top):null,was:window.__anchor.top,following:document.getElementById('jumpBtn').classList.contains('hidden')};});
    assert(held.found,'the row under the reader survived the load');
    assert(Math.abs(held.top-held.was)<=2,'the line under the reader did not move ('+held.was+' -> '+held.top+')');
    assert.equal(held.following,false,'loading history does not resume following');
    assert.equal((await draft(page)).visibleStart,now,'the deeper position is saved for the next reopen');
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('an answer that does not match the request or the cache is ignored',async()=>{
    const {page,errors}=await open();
    // Two gestures: the first is served from the shipped tail, the second has to
    // ask the extension, which is the request these answers are checked against.
    await scrollBack(page,2);
    const settled={rows:await rows(page),first:await firstIndex(page)};
    // The request the panel is actually waiting on, and where its cache now begins.
    const req=await page.evaluate(()=>{const all=window.posted.filter(m=>m.type==='requestParts');const last=all[all.length-1];return{id:last.requestId,before:last.before,limit:Math.min(400,Math.max(1,last.limit||200))};});
    const front=Math.max(0,req.before-req.limit);
    const filler=thread(40).slice(0,20);
    // A stale id, another thread, a gap before the cache, and an empty slice.
    for(const bad of [
      {type:'partsWindow',requestId:req.id+1,sessionId:'window-session',start:front-20,total:2500,parts:filler},
      {type:'partsWindow',requestId:req.id,sessionId:'other-session',start:front-20,total:2500,parts:filler},
      {type:'partsWindow',requestId:req.id,sessionId:'window-session',start:0,total:2500,parts:filler},
      {type:'partsWindow',requestId:req.id,sessionId:'window-session',start:front-20,total:2500,parts:[]}
    ]){
      await emit(page,bad);await page.waitForTimeout(40);
      assert.equal(await rows(page),settled.rows,'a mismatched answer must not change the window');
      assert.equal(await firstIndex(page),settled.first);
    }
    // The same request answered with a slice that ends where the cache begins is
    // taken, and the window reaches back over it. (A slice shorter than the chunk
    // minimum is cached but held back, so this one has to be worth rendering.)
    await page.evaluate(({id,front})=>{const all=window.__all;
      window.dispatchEvent(new MessageEvent('message',{data:{type:'partsWindow',requestId:id,sessionId:'window-session',start:front-40,total:all.length,parts:all.slice(front-40,front)}}));},{id:req.id,front});
    await page.waitForTimeout(60);
    const after={first:await firstIndex(page),rows:await rows(page)};
    assert(after.first<settled.first,'a contiguous answer extends the window ('+settled.first+' -> '+after.first+')');
    assert.equal(after.rows,settled.rows+(settled.first-after.first),'every row the window gained is rendered');
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('a state tick that changes nothing does no transcript work',async()=>{
    const {page,errors}=await open();
    await page.evaluate(()=>{window.__muts=0;new MutationObserver(m=>{window.__muts+=m.length;}).observe(document.getElementById('transcript'),{childList:true,subtree:true,attributes:true,characterData:true});});
    const ticks=await page.evaluate(()=>{const t=[];for(let i=0;i<12;i++){const s=performance.now();window.__ship();t.push(performance.now()-s);}return t;});
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(()=>window.__muts),0,'an idle tick must not touch the transcript');
    assert(Math.max(...ticks)<25,'idle ticks stay cheap: '+Math.max(...ticks).toFixed(1)+'ms');
    // A token arriving on the last part still updates just that row.
    await page.evaluate(()=>{window.__muts=0;const all=window.__all;all[all.length-1]={...all[all.length-1],text:all[all.length-1].text+' more'};window.__ship();});
    await page.waitForTimeout(60);
    const changed=await page.evaluate(()=>window.__muts);
    assert(changed>0&&changed<400,'a real change is applied, and only to the rows it affects ('+changed+' records)');
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('copy and fork on rows the tail no longer ships still resolve',async()=>{
    const {page,errors}=await open();
    await scrollBack(page,2);
    const first=await firstIndex(page);
    assert(first<2260,'older rows are on screen');
    await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true});document.execCommand=()=>{window.copiedResponse=document.activeElement.value;return true;};window.copiedResponse=null;});
    // Tag a row that is on screen now and older than the shipped tail: the first
    // row of the window keeps changing while history loads, so it cannot be targeted.
    await page.waitForTimeout(300);
    // Walk the reader up through the loaded history until a row the tail never
    // shipped has its controls on screen, then tag it so it stays targetable.
    let oldIndex=null;
    for(let step=0;step<8&&oldIndex===null;step++){
      oldIndex=await page.evaluate(()=>{
        const box=document.getElementById('scroll').getBoundingClientRect();
        const row=Array.from(document.querySelectorAll('#transcript section')).find(function(n){
          const button=n.querySelector('.copy-text[data-a="copyReply"]');
          if(!button||!n.querySelector('.fork-turn'))return false;
          const r=button.getBoundingClientRect();
          return r.top>box.top+40&&r.bottom<box.bottom-40;
        });
        if(!row)return null;
        if(row._partIndex>=2260){
          const b=document.getElementById('scroll');
          b.scrollTop=Math.max(0,b.scrollTop-500);b.dispatchEvent(new Event('scroll'));
          return null;
        }
        row.dataset.probe='1';
        return row._partIndex;
      });
      if(oldIndex===null)await page.waitForTimeout(150);
    }
    assert(oldIndex!==null&&oldIndex<2260,'a row the shipped tail does not contain is on screen ('+oldIndex+')');
    const oldRow=page.locator('#transcript section[data-probe]');
    await oldRow.locator('.reply-text').hover();
    const copyBox=await oldRow.locator('.copy-text[data-a="copyReply"]').boundingBox();
    await page.mouse.click(copyBox.x+copyBox.width/2,copyBox.y+copyBox.height/2);
    const copied=await page.evaluate(()=>window.copiedResponse);
    assert.equal(copied,await page.evaluate(i=>'Thought process\n'+window.__all[i].reasoning+'\n\n'+window.__all[i].text,oldIndex),'the copy resolved through the cache, not the shipped tail');
    // A fork button carries its own turn id, which never moves with the window.
    const forkBox=await oldRow.locator('.fork-turn').first().boundingBox();
    await page.mouse.click(forkBox.x+forkBox.width/2,forkBox.y+forkBox.height/2);
    const posted=await page.evaluate(()=>window.posted.filter(m=>m.type==='forkAtMessage').at(-1));
    assert.equal(posted.turnId,await page.evaluate(i=>window.__all[i].forkTurnId,oldIndex));
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('streaming while scrolled back leaves the reader alone',async()=>{
    const {page,errors}=await open();
    await scrollBack(page,2);
    const before={first:await firstIndex(page),rows:await rows(page),box:await box(page)};
    await page.evaluate(()=>{const all=window.__all;all.push({kind:'user',text:'Prompt new: arrived while reading',turnNumber:9001});window.__ship();});
    await page.waitForTimeout(80);
    const after={first:await firstIndex(page),rows:await rows(page),box:await box(page)};
    assert.equal(after.rows,before.rows+1,'the new part joined the bottom of the window, off screen');
    assert.equal(after.first,before.first,'the window did not slide out from under the reader');
    assert.equal(await lastIndex(page),2500,'the newest part is the one that arrived');
    assert(Math.abs(after.box.top-before.box.top)<=2,'the reading position held');
    assert.equal(await page.evaluate(()=>document.getElementById('jumpBtn').classList.contains('hidden')),false,'the jump-to-latest affordance is offered');
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('the window reclaims rows far above the reader',async()=>{
    const {page,errors}=await open();
    let peak=0;
    for(let i=0;i<14&&peak<905;i++){await scrollBack(page);peak=Math.max(peak,await rows(page));}
    assert(peak>900,'the test drove the window past the hard cap ('+peak+' rows)');
    // Move well past the top so nothing can load, then drain anything in flight.
    await page.evaluate(()=>{const b=document.getElementById('scroll');b.scrollTop=b.clientHeight*10;b.dispatchEvent(new Event('scroll'));});
    await page.waitForTimeout(300);
    while(await page.evaluate(()=>window.__serve()))await page.waitForTimeout(120);
    await page.waitForTimeout(1200);
    const seen=await page.evaluate(()=>{const box=document.getElementById('scroll'),top=box.getBoundingClientRect().top;const row=Array.from(document.getElementById('transcript').children).find(n=>n.getBoundingClientRect().bottom>top);return{p:row._partIndex,top:Math.round(row.getBoundingClientRect().top)};});
    const before=await rows(page);
    await page.evaluate(()=>window.__ship());
    await page.waitForTimeout(120);
    const settled=await rows(page);
    assert(settled<before,'rows above the reader were reclaimed: '+before+' -> '+settled);
    assert(await nodes(page)<settled*17,'reclaimed rows left the DOM');
    const still=await page.evaluate(p=>{const row=Array.from(document.getElementById('transcript').children).find(n=>n._partIndex===p);return row?Math.round(row.getBoundingClientRect().top):null;},seen.p);
    assert(still!==null&&Math.abs(still-seen.top)<=2,'what the reader was looking at did not move ('+seen.top+' -> '+still+')');
    assert.equal(await lastIndex(page),2499,'the newest content is still in the window');
    assert.deepEqual(errors,[]);await page.close();
  });
  assert.deepEqual(failures,[],'scrollback windowing regressions failed');
}finally{await browser.close();}
