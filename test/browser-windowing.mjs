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
async function gestureUp(page,serve=true){
  const before=await rows(page);
  await page.evaluate(()=>{const b=document.getElementById('scroll');b.scrollTop=60;b.dispatchEvent(new Event('scroll'));});
  for(let k=0;k<40;k++){
    await page.waitForTimeout(16);
    const pending=await page.evaluate(()=>window.posted.some(m=>m.type==='requestParts'&&!m.__served));
    if(pending){
      if(!serve)return;
      if(await page.evaluate(()=>window.__serve())){await page.waitForTimeout(16);continue;}
    }
    if(!pending&&await rows(page)>=before)break;
  }
}
// The request the panel is waiting on, if any: the slice it expects ends one past
// the cache front, the last part being the overlap it checks.
const pendingRequest=page=>page.evaluate(()=>{const all=window.posted.filter(m=>m.type==='requestParts'&&!m.__served);const last=all[all.length-1];return last?{id:last.requestId,before:last.before}:null;});
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
    // Walk the reader up until the panel has to ask the extension, and leave that
    // request unanswered: it is the one these mismatched answers are checked against.
    await scrollBack(page,1);
    let req=null;
    for(let i=0;i<8&&!req;i++){await gestureUp(page,false);req=await pendingRequest(page);}
    assert(req,'scrolling back past what the panel holds asks the extension');
    const settled={rows:await rows(page),first:await firstIndex(page)};
    const good=await page.evaluate(before=>window.__all.slice(Math.max(0,before-41),before),req.before);
    const alien=good.slice();alien[alien.length-1]={kind:'tool',call:{callId:'alien',name:'x',arguments:'',result:'',done:true,status:'done',metadata:{}},turnNumber:-1};
    // A stale id, another thread, a slice that stops short of the cache, an empty
    // slice, and a contiguous slice whose overlapping part is not the part the
    // cache holds there - a transcript replaced while the answer was in flight.
    for(const bad of [
      {type:'partsWindow',requestId:req.id+1,sessionId:'window-session',start:req.before-good.length,total:2500,parts:good},
      {type:'partsWindow',requestId:req.id,sessionId:'other-session',start:req.before-good.length,total:2500,parts:good},
      {type:'partsWindow',requestId:req.id,sessionId:'window-session',start:req.before-good.length-20,total:2500,parts:good},
      {type:'partsWindow',requestId:req.id,sessionId:'window-session',start:req.before,total:2500,parts:[]},
      {type:'partsWindow',requestId:req.id,sessionId:'window-session',start:req.before-alien.length,total:2500,parts:alien}
    ]){
      await emit(page,bad);await page.waitForTimeout(40);
      assert.equal(await rows(page),settled.rows,'a mismatched answer must not change the window');
      assert.equal(await firstIndex(page),settled.first);
    }
    // The same request answered with a slice that overlaps the cache by one part,
    // and that part is still the same part, is taken: the window reaches back over
    // it. (A slice shorter than the chunk minimum is cached but held back, so this
    // one has to be worth rendering.)
    await emit(page,{type:'partsWindow',requestId:req.id,sessionId:'window-session',start:req.before-good.length,total:2500,parts:good});
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
    assert(Math.max(...ticks)<10,'idle ticks stay cheap: '+Math.max(...ticks).toFixed(1)+'ms');
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
  await check('a long read backwards keeps the window bounded and says where it stops',async()=>{
    const {page,errors}=await open();
    const total=await page.evaluate(()=>window.__all.length);
    let peak=0;
    for(let i=0;i<60;i++){
      await gestureUp(page);
      peak=Math.max(peak,await rows(page));
      if(await firstIndex(page)===0)break;
    }
    const first=await firstIndex(page),shown=await rows(page);
    assert(peak>500,'the test really filled the window ('+peak+' rows)');
    assert(peak<=900,'the window never grows past its hard bound while the reader walks back ('+peak+' rows)');
    assert(shown<total-first,'the thread below the reader is not all on screen ('+shown+' rows for '+(total-first)+' parts behind them)');
    assert.equal(await lastIndex(page),first+shown-1,'the rows on screen are exactly the window');
    assert(await nodes(page)<shown*20,'the DOM stayed proportional to the window, not to the thread');
    assert.equal(await page.evaluate(()=>document.getElementById('historyLater').classList.contains('hidden')),false,'the reader is told the window stops short of the newest');
    assert.equal(await page.evaluate(()=>document.getElementById('historyEarlier').classList.contains('hidden')),true,'nothing older is offered at the beginning');
    // The explicit escape: one click puts the reader back on the live tail, and
    // the window is the tail again rather than everything they walked past.
    assert.equal(await page.evaluate(()=>document.getElementById('jumpBtn').classList.contains('hidden')),false,'a reader far from the newest is offered the jump');
    await page.locator('#jumpBtn').click();
    await page.waitForTimeout(80);
    assert.equal(await lastIndex(page),total-1,'the jump lands on the newest message');
    const back=await rows(page);
    assert(back<=TAIL,'and leaves the walked-past history off screen ('+back+' rows)');
    assert.equal(await page.evaluate(()=>document.getElementById('historyLater').classList.contains('hidden')),true,'the window reaches the end again');
    assert.equal(await page.evaluate(()=>document.getElementById('jumpBtn').classList.contains('hidden')),true,'no jump is offered at the latest');
    assert.equal((await draft(page)).visibleStart,await firstIndex(page),'the place kept for a reopen is the one on screen');
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('reading forward past the far end slides the window and holds the reader',async()=>{
    const {page,errors}=await open();
    for(let i=0;i<60;i++){await gestureUp(page);if(await firstIndex(page)===0)break;}
    assert.equal(await firstIndex(page),0,'the reader reached the first message of the thread');
    assert.equal(await page.evaluate(()=>document.getElementById('historyLater').classList.contains('hidden')),false,'the window stops short of the newest, and offers the rest');
    const total=await page.evaluate(()=>window.__all.length);
    let peak=await rows(page),slides=0;
    for(let i=0;i<14;i++){
      if(await lastIndex(page)===total-1)break;
      const before=await firstIndex(page);
      // Mark the row under the reader, then make one gesture to the far end: the
      // window has to slide onto new ground with that row still where it was.
      const probe=await page.evaluate(()=>{
        const b=document.getElementById('scroll');
        b.scrollTop=b.scrollHeight;
        const top=b.getBoundingClientRect().top;
        const row=Array.from(document.getElementById('transcript').children).find(n=>n.getBoundingClientRect().bottom>top+b.clientHeight*0.5);
        if(!row)return null;
        row.dataset.probe='1';
        const held={p:row._partIndex,top:Math.round(row.getBoundingClientRect().top)};
        b.dispatchEvent(new Event('scroll'));
        return held;
      });
      assert(probe,'there is a row under the reader to hold onto');
      for(let k=0;k<40;k++){await page.waitForTimeout(16);if(await firstIndex(page)!==before)break;}
      const now=await firstIndex(page);
      assert(now>before,'one gesture at the far end slides the window forward ('+before+' -> '+now+')');
      assert(now<=probe.p,'the window still holds the row the reader was looking at');
      slides++;
      peak=Math.max(peak,await rows(page));
      const place=await page.evaluate(()=>{const row=document.querySelector('#transcript section[data-probe]');return row?Math.round(row.getBoundingClientRect().top):null;});
      assert(place!==null,'the row under the reader survived the slide');
      assert(Math.abs(place-probe.top)<=2,'the slide did not move it ('+probe.top+' -> '+place+')');
    }
    assert(slides>=2,'the reader crossed the thread in slides, not in one rebuild ('+slides+')');
    assert(peak<=900,'sliding forward keeps the window bounded too ('+peak+' rows)');
    // One more gesture reaches the true end: the newest content comes back, the
    // offer to load it goes away, and following the latest is possible again.
    await page.evaluate(()=>{const b=document.getElementById('scroll');b.scrollTop=b.scrollHeight;b.dispatchEvent(new Event('scroll'));});
    for(let k=0;k<40;k++){await page.waitForTimeout(16);if(await lastIndex(page)===total-1)break;}
    assert.equal(await lastIndex(page),total-1,'the newest part is back on screen');
    assert.equal(await page.evaluate(()=>document.getElementById('historyLater').classList.contains('hidden')),true,'nothing further is offered at the end');
    assert.equal(await page.evaluate(()=>document.getElementById('jumpBtn').classList.contains('hidden')),true,'the reader is at the latest, so no jump is offered');
    await page.evaluate(()=>{const all=window.__all;all.push({kind:'user',text:'Prompt newest: arrived after the walk',turnNumber:9100});window.__ship();});
    await page.waitForTimeout(120);
    assert.equal(await lastIndex(page),total,'a part that arrives at the end is followed onto the screen');
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('a selection in progress is not slid out of the window',async()=>{
    const {page,errors}=await open({},thread(900));
    for(let i=0;i<12;i++){await gestureUp(page);if(await firstIndex(page)===0)break;}
    assert.equal(await page.evaluate(()=>document.getElementById('historyLater').classList.contains('hidden')),false,'the window stops short of the newest');
    const held=()=>page.evaluate(()=>{const s=window.getSelection();return s&&!s.isCollapsed?s.toString():null;});
    await page.evaluate(()=>{
      const row=document.querySelector('#transcript').children[3];
      const range=document.createRange();range.selectNodeContents(row);
      const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
    });
    const text=await held(),place=await firstIndex(page);
    assert(text&&text.length>4,'the reader really is holding a selection');
    const nearEnd=()=>page.evaluate(()=>{const b=document.getElementById('scroll');b.scrollTop=b.scrollHeight-b.clientHeight-900;b.dispatchEvent(new Event('scroll'));});
    await nearEnd();await page.waitForTimeout(240);
    assert.equal(await held(),text,'dragging toward the far end keeps what the reader selected');
    assert.equal(await firstIndex(page),place,'and the window does not slide out from under it');
    // The asymmetry: loading older parts prepends and drops nothing, so it must
    // still answer the same reader while they hold a selection.
    await page.evaluate(()=>{const b=document.getElementById('scroll');b.scrollTop=60;b.dispatchEvent(new Event('scroll'));});
    for(let k=0;k<30;k++){await page.waitForTimeout(16);if(await page.evaluate(()=>window.posted.some(m=>m.type==='requestParts'&&!m.__served)))await page.evaluate(()=>window.__serve());else break;}
    await page.waitForTimeout(120);
    assert.equal(await held(),text,'and reading backwards with a selection held still works');
    assert(await firstIndex(page)<place,'older parts arrived ('+place+' -> '+await firstIndex(page)+')');
    await page.evaluate(()=>window.getSelection().removeAllRanges());
    await nearEnd();await page.waitForTimeout(240);
    assert(await firstIndex(page)>place,'the same gesture slides the window once the selection is gone');
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('a saved place inside the shipped tail is where the reader comes back to',async()=>{
    const parts=thread(500),place=parts.length-TAIL;
    const {page,errors}=await open({sessions:{'window-session':{visibleStart:place,scrollTop:0,thread:'window-session'}},'thread':'window-session'},parts);
    assert.equal(await firstIndex(page),place,'the reader is back where they left off, above the row budget');
    assert.equal(await rows(page),TAIL,'the window holds every part it was handed');
    assert.equal(await page.evaluate(()=>document.getElementById('historyEarlier').classList.contains('hidden')),false,'older history is still offered');
    assert.equal(await page.evaluate(()=>document.getElementById('jumpBtn').classList.contains('hidden')),false,'coming back to a saved place does not resume following');
    assert.equal((await draft(page)).visibleStart,place,'the place is kept for the next reopen');
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('a transcript replaced under the reader starts over from the new tail',async()=>{
    const {page,errors}=await open();
    await scrollBack(page,2);
    const before=await firstIndex(page);
    // The same session and a longer transcript, shifted by one part: the part at
    // the cache front is no longer that part, so the cached prefix cannot be kept.
    await page.evaluate(()=>{const all=window.__all;window.__all=all.slice(1).concat(all.slice(0,5));window.__ship();});
    await page.waitForTimeout(200);
    const total=await page.evaluate(()=>window.__all.length);
    const now={first:await firstIndex(page),rows:await rows(page)};
    assert(now.first>before,'the window starts over from the new tail ('+before+' -> '+now.first+')');
    assert.equal(now.first,total-now.rows,'every row on screen belongs to the new transcript');
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('a transcript replaced under a reader deep in a truncated window starts over',async()=>{
    const {page,errors}=await open({},thread(900));
    for(let i=0;i<12;i++){await gestureUp(page);if(await firstIndex(page)===0)break;}
    const later=()=>page.evaluate(()=>document.getElementById('historyLater').classList.contains('hidden'));
    assert.equal(await later(),false,'the reader is inside a window that stops short of the newest');
    // A restore in progress: the same session, a much shorter transcript, and a
    // boundary the cache still holds, so only replayComplete says it is a replace.
    await page.evaluate(()=>{window.__all=window.__all.slice(0,300);window.__ship({replayComplete:false});});
    await page.waitForTimeout(120);
    await page.evaluate(()=>window.__ship({replayComplete:true}));
    await page.waitForTimeout(200);
    const total=await page.evaluate(()=>window.__all.length);
    const shown=await rows(page);
    assert.equal(await lastIndex(page),total-1,'the reader ends up on the new transcript, at its end');
    assert.equal(await firstIndex(page),total-shown,'every row on screen belongs to the new transcript');
    assert(shown<=TAIL,'and the window is the tail it was handed ('+shown+' rows for '+total+' parts)');
    assert.equal(await later(),true,'nothing further is offered at the end of a thread that fits');
    assert.equal(await page.evaluate(()=>document.getElementById('historyEarlier').classList.contains('hidden')),false,'older history is still offered');
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('a thread of huge results is bounded by weight, not by row count',async()=>{
    const big='x'.repeat(200000),parts=[];
    for(let i=0;i<40;i++){
      parts.push({kind:'user',text:'Prompt '+i,turnNumber:i});
      parts.push({kind:'tool',call:{callId:'h'+i,name:'read_file',arguments:'{}',result:big,done:true,status:'done',durationMs:5,metadata:{workspace_diff:{files:[{path:'a.ts',hunks:'y'.repeat(400)}]}}},turnNumber:i});
    }
    const {page,errors}=await open({},parts);
    const shown={rows:await rows(page),first:await firstIndex(page)};
    assert(shown.rows<20,'the weight budget bounds the window, not the 160 row budget ('+shown.rows+' rows of 200KB results)');
    assert.equal(shown.first,parts.length-shown.rows,'the rows it does hold are the newest');
    assert.equal(await lastIndex(page),parts.length-1);
    assert.deepEqual(errors,[]);await page.close();
  });
  // 2504 parts, so that after one fetch the cache front lands on a system line:
  // the part kind that carries no turn identity for a witness to hold onto.
  const systemFront=()=>thread(500).concat([1,2,3,4].map(i=>({kind:'system',text:'Extra line '+i,level:'info'})));
  // Replace the transcript under the reader, keeping a marked line in the prefix
  // the panel already holds, then read back over it: the marked line may only
  // appear if the panel kept a prefix from the abandoned transcript.
  async function stalePrefix(mark,replay,mutateBoundary){
    const parts=systemFront();
    parts[2100]={...parts[2100],text:mark+' '+parts[2100].text};
    const {page,errors}=await open({},parts);
    await scrollBack(page,2);
    await page.evaluate(({mark,replay,mutateBoundary,tailStart})=>{
      const all=window.__all.map(p=>p.text&&String(p.text).startsWith(mark)?{...p,text:String(p.text).slice(mark.length+1)}:p);
      // The witness is the part the new tail starts with, which the cache holds at
      // the front of that overlap: a system line, with nothing but its text to go by.
      if(mutateBoundary)all[tailStart]={...all[tailStart],text:all[tailStart].text+' (and it was cancelled, not completed)'};
      window.__all=all;window.__ship(replay?{replayComplete:false,cached:true}:{});
    },{mark,replay,mutateBoundary,tailStart:parts.length-TAIL});
    await page.waitForTimeout(200);
    for(let i=0;i<4;i++)await gestureUp(page);
    const seen=await page.evaluate(mark=>document.getElementById('transcript').textContent.includes(mark),mark);
    const rendered=await rows(page);
    assert.deepEqual(errors,[]);await page.close();
    return {seen,rendered};
  }
  await check('a replaced transcript whose boundary is a system line is not merged',async()=>{
    // Both boundaries are system lines with no turn identity; only their text
    // length tells them apart, so this is the witness that has to hold.
    const {seen,rendered}=await stalePrefix('STALE-A',false,true);
    assert(rendered>200,'the reader did read back over the replaced prefix ('+rendered+' rows)');
    assert(!seen,'no line from the abandoned transcript is left on screen');
  });
  await check('a transcript restored under the reader starts over even when its boundary still matches',async()=>{
    // The boundary part is untouched here, so the witness cannot help: the restore
    // has to be taken on its own word.
    const {seen,rendered}=await stalePrefix('STALE-B',true,false);
    assert(rendered>200,'the reader did read back over the restored prefix ('+rendered+' rows)');
    assert(!seen,'a restored transcript leaves no line from the one it replaced');
  });
  await check('a thread longer than the cache is readable all the way to its first message',async()=>{
    // The cache is capped, and trimming it must never drop the slice a fetch just
    // handed over: on a thread longer than the cap that used to wedge the reader
    // a few hundred messages from the beginning with 'Load earlier' still offered.
    const parts=thread(520);
    const {page,errors}=await open({},parts);
    let peak=0;
    for(let i=0;i<60;i++){
      await gestureUp(page);
      peak=Math.max(peak,await rows(page));
      if(await firstIndex(page)===0)break;
    }
    const first=await firstIndex(page);
    assert(peak<=900,'the walk back never put more than the window on screen ('+peak+' rows for '+parts.length+' parts)');
    assert.equal(first,0,'the reader reaches the first message of the thread ('+first+')');
    assert.equal(await page.evaluate(()=>document.getElementById('historyEarlier').classList.contains('hidden')),true,'nothing older is offered once the beginning is on screen');
    const asked=await page.evaluate(()=>window.posted.filter(m=>m.type==='requestParts').length);
    assert(asked>=10&&asked<=40,'the walk back asked for slices, not for the whole thread ('+asked+' requests)');
    assert.deepEqual(errors,[]);await page.close();
  });
  await check('a thread shorter than the window is rendered whole and never fetched',async()=>{
    const parts=thread(2);
    const {page,errors}=await open({},parts);
    assert.equal(await rows(page),parts.length,'every part is on screen');
    assert.equal(await firstIndex(page),0);
    assert.equal(await page.evaluate(()=>document.getElementById('historyEarlier').classList.contains('hidden')),true,'nothing older is offered');
    await gestureUp(page);
    assert.equal(await page.evaluate(()=>window.posted.filter(m=>m.type==='requestParts').length),0,'it never asks for parts it already has');
    assert.equal(await rows(page),parts.length);
    assert.deepEqual(errors,[]);await page.close();
    const empty=await open({},[]);
    assert.equal(await empty.page.evaluate(()=>document.getElementById('transcript').firstElementChild.className),'welcome','an empty thread shows the welcome');
    assert.deepEqual(empty.errors,[]);await empty.page.close();
  });
  assert.deepEqual(failures,[],'scrollback windowing regressions failed');
}finally{await browser.close();}
