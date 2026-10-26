import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm} from 'node:fs/promises';
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
  await assert.rejects(store.stageChunk({text:'end',name:'x.txt',requestId:2,index:1,totalChunks:2},source),/out of order/);
  for(let i=0;i<4;i++)await store.stage('file '+i,'file'+i+'.txt',source);
  await assert.rejects(store.stage('fifth','fifth.txt',source),/four text/);
}));

test('oversized message becomes readable file reference and keeps original bytes',()=>fixture(async root=>{
  const controller=new SessionController({}, {log(){}},{},root,'s',root);
  const text='original user request\n'+'x'.repeat(200000);
  const prompt=await controller.withAttachments(text,[],[],{});
  const result=splitTextFileReferences(prompt);
  assert.equal(result.text,'');assert.equal(result.textFiles.length,1);
  assert.equal(result.textFiles[0].name,'message.txt');
  assert.equal(await readFile(result.textFiles[0].path,'utf8'),text);
  assert(prompt.includes('original message'));assert(prompt.length<2000);
  controller.dispose();
}));
