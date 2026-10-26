import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const require=createRequire(import.meta.url);
const {browseRuntimeDirectory,readSelectedRuntimeFiles,selectedImage}=require('../out/file-browser.js');
const {SessionController}=require('../out/manager.js');
const {TextAttachmentStore}=require('../out/text-attachments.js');
async function fixture(run){const root=await mkdtemp(join(tmpdir(),'nodecode-browse-'));try{await run(root);}finally{await rm(root,{recursive:true,force:true});}}

test('native browser is shallow, paged and permits explicit outside-cwd symlink navigation',()=>fixture(async root=>{
  const cwd=join(root,'cwd'),outside=join(root,'outside');await mkdir(cwd);await mkdir(outside);
  await writeFile(join(cwd,'.hidden'),'hidden');
  for(let i=0;i<105;i++)await writeFile(join(cwd,`file-${String(i).padStart(3,'0')}.txt`),'text');
  await symlink(outside,join(cwd,'linked'));
  const first=await browseRuntimeDirectory(cwd);assert.equal(first.source,'nodecode');assert.equal(first.entries.length,100);assert.equal(first.nextOffset,100);assert(!first.entries.some(e=>e.name==='.hidden'));
  assert.equal((await browseRuntimeDirectory(cwd,{offset:100})).entries.length,6);
  assert.equal((await browseRuntimeDirectory(cwd,{query:'.hidden',showHidden:true})).entries[0].name,'.hidden');
  const linked=await browseRuntimeDirectory(cwd,{path:join(cwd,'linked')});assert.equal(linked.path,await realpath(outside));assert.equal(linked.parent,await realpath(root));
  await assert.rejects(browseRuntimeDirectory(cwd,{offset:-1}),/Invalid file page/);
}));

test('selected text and image bytes carry origin and original filename through private staging',()=>fixture(async root=>{
  const file=join(root,'note.txt');await writeFile(file,'chosen outside a workspace');
  const files=await readSelectedRuntimeFiles([file]);assert.equal(new TextDecoder().decode(files[0].data),'chosen outside a workspace');
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZcToAAAAASUVORK5CYII=','base64');
  assert.equal(selectedImage({name:'image.dat',data:png}).mediaType,'image/png');
  let checks=0;const controller=new SessionController({}, {log(){}},{assertLocalRuntimeFiles:async()=>checks++},root,'s',root);
  try{
    const selected=await controller.attachSelectedFiles([...files,{name:'image.dat',data:png}],{},'computer');
    assert.equal(selected.images[0].origin,'computer');assert.equal(selected.images[0].name,'image.dat');
    assert.equal(selected.textFiles[0].origin,'computer');assert.equal(selected.textFiles[0].originalPath,await realpath(file));assert.equal(checks,1);
    const restored=await new TextAttachmentStore(root,'s').resolve([selected.textFiles[0].ref],{});
    assert.equal(restored[0].origin,'computer');assert.equal(restored[0].originalPath,await realpath(file));
    await assert.rejects(controller.attachSelectedFiles([{name:'binary.dat',data:Buffer.from([0,255])}],{},'computer'),/not a supported image or UTF-8/);
  }finally{controller.dispose();}
}));

test('native browser never substitutes local filesystem when runtime identity is not verified',async()=>{
  const controller=new SessionController({}, {log(){}},{assertLocalRuntimeFiles:async()=>{throw Error('different filesystem');}},'/local','s');
  try{await assert.rejects(controller.browseRuntimeFiles({path:'/'},{}),/different filesystem/);}finally{controller.dispose();}
});

test('native attachments require files listed to that exact panel',()=>fixture(async root=>{
  await writeFile(join(root,'picked.txt'),'chosen');
  const controller=new SessionController({}, {log(){}},{assertLocalRuntimeFiles:async()=>{}},root,'s',root),source={};
  try{
    const listing=await controller.browseRuntimeFiles({path:root},source),file=listing.entries.find(e=>e.name==='picked.txt').path;
    await assert.rejects(controller.attachRuntimeFiles([file],{}),/shown in the Nodecode browser/);
    const result=await controller.attachRuntimeFiles([file],source);
    assert.equal(result.textFiles[0].origin,'nodecode');
  }finally{controller.dispose();}
}));

test('special files fail promptly rather than blocking an attachment read',{skip:process.platform==='win32'},()=>fixture(async root=>{
  const fifo=join(root,'pipe');execFileSync('mkfifo',[fifo]);
  await assert.rejects(readSelectedRuntimeFiles([fifo]),/regular file/);
}));
