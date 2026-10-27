import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {TextAttachmentStore,appendTextFileReferences,splitTextFileReferences,hasUnpairedSurrogate,PASTE_FILE_THRESHOLD_CHARS,MAX_PROMPT_TEXT_CHARS}=require('../out/text-attachments.js');
const {SessionController}=require('../out/manager.js');
const {SessionStore}=require('../out/store.js');
async function fixture(run){const dir=await mkdtemp(join(tmpdir(),'nodecode-text-'));try{await run(dir);}finally{await rm(dir,{recursive:true,force:true});}}

test('Prime thresholds and chunked unicode text preserve complete bytes across restore',()=>fixture(async root=>{
  assert.equal(PASTE_FILE_THRESHOLD_CHARS,32000);assert.equal(MAX_PROMPT_TEXT_CHARS,200000);
  const store=new TextAttachmentStore(root,'session-a'),source={};
  const text='😀'.repeat(40000)+'end';
  const attachment=await store.stage(text,'pasted-text.txt',source);
  assert.equal(await readFile(attachment.path,'utf8'),text);
  assert.equal(attachment.byteLength,Buffer.byteLength(text));
  assert.equal((await stat(attachment.path)).mode&0o777,0o600);
  const restarted=new TextAttachmentStore(root,'session-a');
  assert.deepEqual(await restarted.resolve([attachment.ref],{}),[attachment]);
  await assert.rejects(new TextAttachmentStore(root,'session-b').resolve([attachment.ref],{}),/another session/);
  const prompt=appendTextFileReferences('Explain', [attachment]);
  assert(prompt.includes(attachment.path));assert(!prompt.includes(text));
  assert.deepEqual(splitTextFileReferences(prompt),{text:'Explain',textFiles:[attachment]});
  const view=new SessionStore();
  view.applyFrame({type:'session_stream_event',sequence:1,event:{type:'turn.input_committed',payload:{role:'user',message:prompt}}});
  assert.equal(view.view().parts[0].text,'Explain');assert.deepEqual(view.view().parts[0].textFiles,[attachment]);
}));

test('chunk validation refuses incomplete uploads, invalid Unicode and oversized combined input',()=>fixture(async root=>{
  const store=new TextAttachmentStore(root,'s'),source={};
  await assert.rejects(store.stageChunk({text:'last',name:'x.txt',requestId:1,index:1,totalChunks:2},source),/out of order/);
  await assert.rejects(store.stage('\ud800','x.txt',source),/Unicode/);
  assert.equal(hasUnpairedSurrogate('😀'),false);
  await assert.rejects(store.stage('x'.repeat(8*1024*1024+1),'x.txt',source),/8 MiB/);
  const initial=await store.stageChunk({text:'begin',name:'x.txt',requestId:2,index:0,totalChunks:2},source);
  assert.equal(initial.attachment,undefined);
  store.cancel(2,source);
  await assert.rejects(store.stageChunk({text:'end',name:'x.txt',requestId:2,index:1,totalChunks:2},source),/cancelled/);
  for(let i=0;i<4;i++)await store.stage('file '+i,'file'+i+'.txt',source);
  await assert.rejects(store.stage('fifth','fifth.txt',source),/four text/);
}));

test('oversized message becomes readable file reference and keeps original bytes',()=>fixture(async root=>{
  const controller=new SessionController({}, {log(){}},{assertLocalRuntimeFiles:async()=>{}},root,'s',root);
  const text='original user request\n'+'x'.repeat(200000);
  const prompt=await controller.withAttachments(text,[],[],{});
  const result=splitTextFileReferences(prompt);
  assert.equal(result.text,'');assert.equal(result.textFiles.length,1);
  assert.equal(result.textFiles[0].name,'message.txt');
  assert.equal(await readFile(result.textFiles[0].path,'utf8'),text);
  assert(prompt.includes('original message'));assert(prompt.length<2000);
  controller.dispose();
}));


test('every local text-file staging and send route verifies the runtime filesystem',()=>fixture(async root=>{
  const source={},calls=[];
  const controller=new SessionController({}, {log(){}},{assertLocalRuntimeFiles:async()=>{calls.push('check');throw Error('different filesystem');}},root,'s',root);
  try{
    await assert.rejects(controller.stageTextAttachmentChunk({text:'paste',name:'paste.txt',requestId:1,index:0,totalChunks:1},source),/different filesystem/);
    await assert.rejects(controller.withAttachments('x'.repeat(200001),[],[],source),/different filesystem/);
    const local=new TextAttachmentStore(root,'s'),attachment=await local.stage('saved local draft','saved.txt',{});
    await assert.rejects(controller.withAttachments('Read',[],[attachment.ref],source),/different filesystem/);
    assert.equal(calls.length,3);
    assert.equal(await controller.withAttachments('plain remote prompt',[],[],source),'plain remote prompt');
    assert.equal(calls.length,3);
  }finally{controller.dispose();}
}));

test('explicit removal deletes unsent files but preserves active holders and committed history',()=>fixture(async root=>{
  const store=new TextAttachmentStore(root,'s'),first={},second={};
  const draft=await store.stage('draft','draft.txt',first);
  await store.resolve([draft.ref],second);
  await store.release(draft.ref,first);
  assert.equal(await readFile(draft.path,'utf8'),'draft');
  await store.release(draft.ref,second);
  await assert.rejects(stat(draft.path),{code:'ENOENT'});
  assert.deepEqual(await readdir(join(root,'text-attachments')),[]);
  const accepted=await store.stage('accepted','accepted.txt',first);
  await store.commit([accepted.ref],first);
  await store.release(accepted.ref,first);
  assert.equal(await readFile(accepted.path,'utf8'),'accepted');
  const restarted=new TextAttachmentStore(root,'s'),third={};
  await restarted.resolve([accepted.ref],third);await restarted.release(accepted.ref,third);
  assert.equal(await readFile(accepted.path,'utf8'),'accepted');
}));

test('closing a view preserves its saved draft while later explicit removal reclaims storage',()=>fixture(async root=>{
  const first=new TextAttachmentStore(root,'s'),source={};
  const draft=await first.stage('unsent saved draft','draft.txt',source);first.close(source);
  assert.equal(await readFile(draft.path,'utf8'),'unsent saved draft');
  const reopened=new TextAttachmentStore(root,'s'),restored={};
  await reopened.resolve([draft.ref],restored);await reopened.release(draft.ref,restored);
  await assert.rejects(stat(draft.path),{code:'ENOENT'});
}));

test('a fork opens only the exact text attachment present in its inherited history',()=>fixture(async root=>{
  const parent=new TextAttachmentStore(root,'parent'),source={};
  const inherited=await parent.stage('ancestor contents','ancestor.txt',source);
  const unrelated=await parent.stage('not inherited','unrelated.txt',source);
  const child=new SessionController({}, {log(){}},{assertLocalRuntimeFiles:async()=>{}},root,'child',root);
  try{
    child.store.applyFrame({type:'session_stream_event',session_id:'child',sequence:1,event:{type:'turn.input_committed',payload:{role:'user',message:appendTextFileReferences('Inherited input',[inherited])}}});
    assert.equal(await child.openTextAttachment(inherited.ref,{}),inherited.path);
    await assert.rejects(child.openTextAttachment(unrelated.ref,{}),/another session/);
    await assert.rejects(child.withAttachments('Reuse',[],[inherited.ref],{}),/another session/);
    const forged={...unrelated,path:inherited.path};
    child.store.applyFrame({type:'session_stream_event',session_id:'child',sequence:2,event:{type:'turn.input_committed',payload:{role:'user',message:appendTextFileReferences('Forged mismatch',[forged])}}});
    await assert.rejects(child.openTextAttachment(unrelated.ref,{}),/another session/);
  }finally{child.dispose();}
}));

test('controller commits all prepared text files, including automatically staged messages',()=>fixture(async root=>{
  const controller=new SessionController({}, {log(){}},{assertLocalRuntimeFiles:async()=>{}},root,'s',root),source={};
  try{
    const staged=(await controller.stageTextAttachmentChunk({text:'selected file',name:'selected.txt',requestId:1,index:0,totalChunks:1},source)).attachment;
    const prompt=await controller.withAttachments('x'.repeat(200001),[],[staged.ref],source);
    const files=splitTextFileReferences(prompt).textFiles;
    assert.equal(files.length,2);
    await controller.commitTextAttachments(prompt,source);
    for(const file of files){await controller.releaseTextAttachment(file.ref,source);assert.equal((await stat(file.path)).size,file.byteLength);}
  }finally{controller.dispose();}
}));

test('failed staging metadata writes remove the incomplete text file',()=>fixture(async root=>{
  const fs=require('fs/promises'),open=fs.open;
  fs.open=async(file,...args)=>{if(String(file).endsWith('.json'))throw Error('metadata write failed');return open(file,...args);};
  try{
    await assert.rejects(new TextAttachmentStore(root,'s').stage('partial write','partial.txt',{}),/metadata write failed/);
    assert.deepEqual(await readdir(join(root,'text-attachments')),[]);
  }finally{fs.open=open;}
}));

test('failed workspace reference preparation removes only its generated message file',()=>fixture(async root=>{
  const controller=new SessionController({}, {log(){}},{assertLocalRuntimeFiles:async()=>{}},root,'s',root),source={};
  try{
    const selected=(await controller.stageTextAttachmentChunk({text:'keep draft',name:'draft.txt',requestId:1,index:0,totalChunks:1},source)).attachment;
    await assert.rejects(controller.withAttachments('x'.repeat(200001),['does-not-exist'],[selected.ref],source));
    assert.equal(await readFile(selected.path,'utf8'),'keep draft');
    assert.equal((await readdir(join(root,'text-attachments'))).filter(name=>name.endsWith('.txt')).length,1);
  }finally{controller.dispose();}
}));


test('separate panel stores preserve another holder until every view explicitly removes the draft',()=>fixture(async root=>{
  const first=new TextAttachmentStore(root,'s'),second=new TextAttachmentStore(root,'s'),a={},b={};
  const file=await first.stage('shared saved draft','shared.txt',a);
  await second.resolve([file.ref],b);await first.release(file.ref,a);
  assert.equal(await readFile(file.path,'utf8'),'shared saved draft');
  await second.release(file.ref,b);await assert.rejects(stat(file.path),{code:'ENOENT'});
}));

test('a restored draft can be removed directly without a previous host-side hold',()=>fixture(async root=>{
  const first=new TextAttachmentStore(root,'s'),source={};
  const file=await first.stage('saved draft','saved.txt',source);first.close(source);
  await new TextAttachmentStore(root,'s').release(file.ref,{});
  await assert.rejects(stat(file.path),{code:'ENOENT'});
}));

test('definitively rejected preparation releases its generated file but keeps selected drafts',()=>fixture(async root=>{
  const controller=new SessionController({}, {log(){}},{assertLocalRuntimeFiles:async()=>{}},root,'s',root),source={};
  try{
    const selected=(await controller.stageTextAttachmentChunk({text:'keep draft',name:'draft.txt',requestId:1,index:0,totalChunks:1},source)).attachment;
    const prompt=await controller.withAttachments('x'.repeat(200001),[],[selected.ref],source),files=splitTextFileReferences(prompt).textFiles;
    await controller.releasePreparedTextAttachments(prompt,source,[selected.ref]);
    assert.equal(await readFile(selected.path,'utf8'),'keep draft');
    await assert.rejects(stat(files.find(file=>file.ref!==selected.ref).path),{code:'ENOENT'});
  }finally{controller.dispose();}
}));

test('failed metadata commit preserves the draft files rather than deleting history input',()=>fixture(async root=>{
  const store=new TextAttachmentStore(root,'s'),source={},file=await store.stage('admitted input','saved.txt',source);
  const fs=require('fs/promises'),rename=fs.rename;
  fs.rename=async()=>{throw Error('metadata commit failed');};
  try{
    await assert.rejects(store.commit([file.ref],source),/metadata commit failed/);
    assert.equal(await readFile(file.path,'utf8'),'admitted input');
    assert.equal((await readdir(join(root,'text-attachments'))).some(name=>name.endsWith('.tmp')),false);
    await store.release(file.ref,source);
    assert.equal(await readFile(file.path,'utf8'),'admitted input');
  }finally{fs.rename=rename;}
  await store.commit([file.ref],source);
  await store.release(file.ref,source);
  assert.equal(await readFile(file.path,'utf8'),'admitted input');
}));


test('a send-scoped holder survives closing the composer until admission is settled',()=>fixture(async root=>{
  const store=new TextAttachmentStore(root,'s'),composer={},submission={};
  const file=await store.stage('pending admission','pending.txt',composer);
  await store.resolve([file.ref],submission);store.close(composer);
  await store.release(file.ref,{});
  assert.equal(await readFile(file.path,'utf8'),'pending admission');
  await store.commit([file.ref],submission);store.close(submission);
  await store.release(file.ref,{});
  assert.equal(await readFile(file.path,'utf8'),'pending admission');
}));

test('restarting a partial upload releases its reservation and rejects delayed cancelled chunks',()=>fixture(async root=>{
  const store=new TextAttachmentStore(root,'s'),source={};
  for(let requestId=1;requestId<=6;requestId++){
    if(requestId>1)store.cancel(requestId-1,source);
    await store.stageChunk({text:'x'.repeat(64000),name:'restored.txt',requestId,index:0,totalChunks:2},source);
    store.checkCapacity(3,3,source);
  }
  for(const index of [0,1])await assert.rejects(store.stageChunk({text:'stale',name:'restored.txt',requestId:1,index,totalChunks:2},source),/cancelled/);
  const result=await store.stageChunk({text:'end',name:'restored.txt',requestId:6,index:1,totalChunks:2},source);
  assert.equal(await readFile(result.attachment.path,'utf8'),'x'.repeat(64000)+'end');
  for(let i=0;i<3;i++)await store.stage('more '+i,'more'+i+'.txt',source);
  await assert.rejects(store.stage('fifth','fifth.txt',source),/four text/);
  store.close(source);
}));

test('cancelling before an asynchronously admitted first chunk prevents a ghost upload',()=>fixture(async root=>{
  const controller=new SessionController({},{log(){}},{assertLocalRuntimeFiles:()=>new Promise(resolve=>{ready=resolve;})},root,'s',root),source={};
  let ready;
  try{
    const pending=controller.stageTextAttachmentChunk({text:'old',name:'old.txt',requestId:7,index:0,totalChunks:2},source);
    controller.cancelTextAttachment(7,source);ready();
    await assert.rejects(pending,/cancelled/);
    controller.textAttachments.checkCapacity(4,4,source);
  }finally{controller.dispose();}
}));
