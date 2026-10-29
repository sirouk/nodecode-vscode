// Optional Chromium regressions for large drafts, restored staging, and reference roots.
import assert from 'node:assert/strict';
import {createRequire,Module} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url),load=Module._load;
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
Module._load=function(name,...args){return name==='vscode'?{Uri:{joinPath:()=>({toString:()=>''})}}:load.call(this,name,...args);};
const {SessionPanel}=require('../out/panel.js');Module._load=load;
const {TextAttachmentStore}=require('../out/text-attachments.js');
const {SessionController}=require('../out/manager.js');
const panel=Object.create(SessionPanel.prototype);panel.controller={sessionId:'composition-regression'};
panel.panel={webview:{cspSource:'https://webview.local'}};
panel.markUri='data:image/svg+xml;base64,'+fs.readFileSync(new URL('../media/icon.svg',import.meta.url)).toString('base64');
panel.markdownUri='https://webview.local/markdown.js';
const html=panel.html().replace(/<script nonce="([^"]+)" src="[^"]+"><\/script>/,(_,nonce)=>'<script nonce="'+nonce+'">'+fs.readFileSync(new URL('../out/markdown.js',import.meta.url),'utf8')+'</script>');
const state={type:'state',connection:'connected',history:[],view:{sessionId:'composition-regression',title:'Composition',cwd:'/session-cwd',parts:[],queue:[],threads:[],processes:[],totals:{},replayComplete:true}};
const browser=await chromium.launch({headless:true});
const emit=(page,message)=>page.evaluate(m=>window.dispatchEvent(new MessageEvent('message',{data:m})),message);
const posted=(page,type)=>page.evaluate(type=>window.posted.filter(m=>m.type===type).at(-1),type);
const saved=page=>page.evaluate(()=>window.savedState);
const draft=page=>page.evaluate(()=>window.savedState.sessions['composition-regression']);
async function open(savedState={}){
  const page=await browser.newPage({viewport:{width:960,height:760}}),errors=[];
  page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(savedState=>{window.posted=[];window.savedState=savedState;window.acquireVsCodeApi=()=>({getState:()=>window.savedState,setState:s=>{window.savedState=structuredClone(s);},postMessage:m=>window.posted.push(m)});},savedState);
  await page.goto('data:text/html,'+encodeURIComponent(html));
  await page.waitForFunction(()=>window.posted.some(m=>m.type==='ready'));
  await emit(page,state);return {page,errors};
}
const failures=[];
async function check(name,run){try{await run();console.log('PASS '+name);}catch(error){failures.push(name);console.error('FAIL '+name+'\n'+error.stack);}}
try{
  await check('typing across the large-draft threshold retains selected file context through reload and send',async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'nodecode-composition-')),source={};
    fs.writeFileSync(path.join(root,'source.ts'),'SELECTED SOURCE CONTENT');
    const store=new TextAttachmentStore(root,'composition-regression');
    const controller=new SessionController({},{log(){}},{assertLocalRuntimeFiles:async()=>{}},root,'composition-regression',root);
    let {page,errors}=await open();
    try{
      const composer=page.locator('#composer');await composer.fill('Review @source');
      await page.waitForFunction(()=>window.posted.some(m=>m.type==='searchFiles'));
      await emit(page,{type:'fileSearchResults',requestId:(await posted(page,'searchFiles')).requestId,files:[{path:'source.ts'}]});
      await composer.press('Tab');await composer.press('End');await composer.press('Shift+Enter');
      await page.keyboard.insertText('x'.repeat(31980));assert.equal((await draft(page)).draft.length,31999);
      await composer.press('x');
      const converted=await draft(page);assert.deepEqual(converted.files,['source.ts']);assert.equal(converted.draft,'@source.ts ');
      const first=await posted(page,'stageTextChunk'),result=await store.stageChunk(first,source);
      assert(first.text.startsWith('Review @source.ts'));assert.equal(first.text.length,32000);
      await emit(page,{type:'textAttachmentChunk',...result});assert.deepEqual(errors,[]);
      const restored=await open(await saved(page));await page.close();page=restored.page;errors=restored.errors;
      assert.equal(await page.locator('#composer').inputValue(),'@source.ts ');
      await page.locator('#sendBtn').click();const send=await posted(page,'send');
      assert.deepEqual(send.files,['source.ts']);assert.equal(send.textFiles.length,1);
      const prompt=await controller.withAttachments(send.text,send.files,send.textFiles,{});
      assert.match(prompt,/SELECTED SOURCE CONTENT/);assert.equal(fs.readFileSync(result.attachment.path,'utf8'),first.text);
      await emit(page,{type:'sendAccepted',requestId:send.requestId});assert.deepEqual((await draft(page)).files,[]);
      assert.deepEqual(errors,[]);
    }finally{await page.close();store.close(source);controller.dispose();fs.rmSync(root,{recursive:true,force:true});}
  });
  await check('converted file references stay editable and removal revokes their selected context',async()=>{
    const text='@source.ts '+'x'.repeat(31988),savedState={sessions:{'composition-regression':{draft:text,inlineRefs:[{path:'source.ts',start:0,end:10}]}}};
    const {page,errors}=await open(savedState);
    try{await page.locator('#composer').press('End');await page.locator('#composer').press('x');
      assert.deepEqual((await draft(page)).files,['source.ts']);
      await page.locator('#composer').fill('Additional instructions');assert.deepEqual((await draft(page)).files,[]);assert.deepEqual(errors,[]);
    }finally{await page.close();}
  });
  await check('restoring one partial upload repeatedly cancels old reservations before restaging',async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'nodecode-upload-recreation-')),store=new TextAttachmentStore(root,'composition-regression'),source={};
    let savedState={},page,finalChunk,errors;
    try{
      for(let attempt=0;attempt<6;attempt++){
        ({page,errors}=await open(savedState));
        if(attempt===0)await page.locator('#composer').fill('x'.repeat(65000));
        await page.waitForFunction(()=>window.posted.some(m=>m.type==='stageTextChunk'));
        const messages=await page.evaluate(()=>window.posted.filter(m=>m.type==='cancelTextAttachment'||m.type==='stageTextChunk'));
        if(attempt>0){assert.equal(messages[0].type,'cancelTextAttachment');assert.equal(messages[0].requestId,finalChunk.requestId);}
        for(const message of messages){if(message.type==='cancelTextAttachment')store.cancel(message.requestId,source);else {finalChunk=message;await store.stageChunk(message,source);}}
        store.checkCapacity(3,3,source);assert.equal((await draft(page)).textFiles.length,1);assert.deepEqual(errors,[]);
        savedState=await saved(page);await page.close();page=undefined;
      }
      ({page,errors}=await open(savedState));
      await page.waitForFunction(()=>window.posted.some(m=>m.type==='stageTextChunk'));
      for(const message of await page.evaluate(()=>window.posted.filter(m=>m.type==='cancelTextAttachment'||m.type==='stageTextChunk'))){
        if(message.type==='cancelTextAttachment')store.cancel(message.requestId,source);
        else {finalChunk=message;await emit(page,{type:'textAttachmentChunk',...await store.stageChunk(message,source)});}
      }
      await page.waitForFunction(()=>window.posted.some(m=>m.type==='stageTextChunk'&&m.index===1));
      const result=await store.stageChunk(await posted(page,'stageTextChunk'),source);await emit(page,{type:'textAttachmentChunk',...result});
      assert.equal(fs.readFileSync(result.attachment.path,'utf8'),'x'.repeat(65000));
      for(let i=0;i<3;i++)await store.stage('other '+i,'other'+i+'.txt',source);
      assert.deepEqual(errors,[]);
    }finally{if(page)await page.close();store.close(source);fs.rmSync(root,{recursive:true,force:true});}
  });
  await check('selected user reference links carry workspace scope while assistant and changed-file links do not',async()=>{
    const {page,errors}=await open();
    try{
      await emit(page,{...state,view:{...state.view,parts:[{kind:'user',text:'Review @src/same.ts',files:['src/same.ts']},{kind:'assistant',text:'Inspect `src/same.ts`',durable:true}]}});
      await page.locator('.msg.user a').click();assert.equal((await posted(page,'openFile')).workspaceReference,true);
      await page.locator('.msg.assistant a').click();assert.equal((await posted(page,'openFile')).workspaceReference,undefined);
      await emit(page,{...state,view:{...state.view,parts:[{kind:'user',text:'Inspect `src/other.ts` and @src/same.ts',files:['src/same.ts']}]}});
      await page.locator('.msg.user a').first().click();assert.equal((await posted(page,'openFile')).workspaceReference,undefined);
      await emit(page,{...state,view:{...state.view,modifiedFiles:[{path:'src/same.ts',added:1,removed:0,patch:'@@ -0,0 +1 @@\n+changed',changeCount:1}]}});
      await page.locator('#fileDetails > summary').click();await page.locator('#fileList .diff-open').click();
      assert.equal((await posted(page,'openFile')).path,'src/same.ts');assert.equal((await posted(page,'openFile')).workspaceReference,undefined);
      assert.deepEqual(errors,[]);
    }finally{await page.close();}
  });
  await check('a tick that omits unchanged collections keeps the file list and the prompt history',async()=>{
    const {page,errors}=await open();
    try{
      await emit(page,{...state,history:['an earlier prompt'],view:{...state.view,modifiedFiles:[{path:'src/kept.ts',added:2,removed:1,changeCount:1,patch:'@@ -1 +1 @@\n-old\n+new'}]}});
      await page.locator('#fileDetails > summary').click();
      assert.equal(await page.locator('#fileList .diff-file').count(),1,'the recorded file is listed');
      // The next tick ships neither collection: the panel keeps what it holds.
      await emit(page,{...state,historyOmitted:true,view:{...state.view,modifiedFilesOmitted:true}});
      assert.equal(await page.locator('#fileList .diff-file').count(),1,'an omitted file list is the one already shown');
      assert((await page.locator('#fileList .diff-file').first().textContent()).includes('kept.ts'),'and it is still the same file');
      await page.locator('#composer').click();
      await page.keyboard.press('ArrowUp');
      assert.equal(await page.inputValue('#composer'),'an earlier prompt','an omitted prompt history is the one already held');
      assert.deepEqual(errors,[]);
    }finally{await page.close();}
  });
}finally{await browser.close();}
if(failures.length)process.exitCode=1;
