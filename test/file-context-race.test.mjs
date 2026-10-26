import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(import.meta.url);
const fs=require('node:fs/promises');
const {withFileReferences,splitFileReferences}=require('../out/file-context.js');
const {readSelectedRuntimeFiles}=require('../out/file-browser.js');

async function fixture(run){
  const base=await fs.mkdtemp(join(tmpdir(),'nodecode-file-race-'));
  const root=join(base,'workspace'),outside=join(base,'outside');
  await fs.mkdir(root);await fs.mkdir(outside);await fs.mkdir(join(root,'nested'));
  const file=join(root,'nested','selected.txt');
  await fs.writeFile(file,'intended input');await fs.writeFile(join(outside,'selected.txt'),'outside secret');
  try{await run({root,outside,file});}finally{await fs.rm(base,{recursive:true,force:true});}
}

async function atOpen(substitute,run,withoutNoFollow=false){
  const original=fs.open;
  let changed=false,reads=0,opened=0,closed=0;
  fs.open=async(...args)=>{
    if(!changed){changed=true;await substitute();}
    if(withoutNoFollow)args[1]&=~(require('node:fs').constants.O_NOFOLLOW??0);
    const handle=await original(...args),read=handle.read.bind(handle),close=handle.close.bind(handle);
    opened++;
    handle.read=(...args)=>{reads++;return read(...args);};
    handle.close=(...args)=>{closed++;return close(...args);};
    return handle;
  };
  try{await run();assert.equal(reads,0,'unverified substituted contents must not be read');assert.equal(closed,opened,'rejected descriptors must be closed');}
  finally{fs.open=original;}
}

for(const [label,read] of [
  ['workspace reference',({root})=>withFileReferences(root,'Review',['nested/selected.txt'])],
  ['runtime selection',({file})=>readSelectedRuntimeFiles([file])],
]){
  test(label+' rejects a leaf symlink substituted between checking and opening',{skip:process.platform==='win32'},()=>fixture(async context=>{
    await atOpen(async()=>{await fs.rename(context.file,context.file+'.old');await fs.symlink(join(context.outside,'selected.txt'),context.file);},async()=>{
      await assert.rejects(read(context),/changed|symbolic|ELOOP|too many levels/i);
    });
  }));
  test(label+' rejects a substituted leaf when O_NOFOLLOW is unavailable',{skip:process.platform==='win32'},()=>fixture(async context=>{
    await atOpen(async()=>{await fs.rename(context.file,context.file+'.old');await fs.symlink(join(context.outside,'selected.txt'),context.file);},async()=>{
      await assert.rejects(read(context),/changed/i);
    },true);
  }));
  test(label+' rejects an intermediate symlink substituted between checking and opening',{skip:process.platform==='win32'},()=>fixture(async context=>{
    const directory=join(context.root,'nested');
    await atOpen(async()=>{await fs.rename(directory,directory+'.old');await fs.symlink(context.outside,directory);},async()=>{
      await assert.rejects(read(context),/changed|inside the workspace/i);
    });
  }));
  test(label+' rejects a different regular file substituted at the same path',()=>fixture(async context=>{
    await atOpen(async()=>{await fs.rename(context.file,context.file+'.old');await fs.writeFile(context.file,'replacement input');},async()=>{
      await assert.rejects(read(context),/changed/i);
    });
  }));
  test(label+' rechecks the selected path after the descriptor opens',{skip:process.platform==='win32'},()=>fixture(async context=>{
    const original=fs.open;let reads=0,closed=false;
    fs.open=async(...args)=>{
      const handle=await original(...args),read=handle.read.bind(handle),close=handle.close.bind(handle);
      await fs.rename(context.file,context.file+'.old');await fs.symlink(join(context.outside,'selected.txt'),context.file);
      handle.read=(...args)=>{reads++;return read(...args);};handle.close=(...args)=>{closed=true;return close(...args);};
      return handle;
    };
    try{await assert.rejects(read(context),/changed/i);assert.equal(reads,0);assert.equal(closed,true);}finally{fs.open=original;}
  }));
}

test('stable in-workspace symbolic links and explicit runtime selections outside the workspace remain supported',{skip:process.platform==='win32'},()=>fixture(async({root,outside,file})=>{
  await fs.symlink(file,join(root,'linked.txt'));
  const prompt=await withFileReferences(root,'Review',['linked.txt']);
  assert.match(prompt,/intended input/);assert.deepEqual(splitFileReferences(prompt).files,['linked.txt']);
  await fs.symlink(join(outside,'selected.txt'),join(root,'external.txt'));
  const selected=await readSelectedRuntimeFiles([join(root,'external.txt')]);
  assert.equal(selected[0].data.toString(),'outside secret');assert.equal(selected[0].originalPath,await fs.realpath(join(outside,'selected.txt')));
}));
