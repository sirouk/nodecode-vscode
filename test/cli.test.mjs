import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire,Module} from 'node:module';
const require=createRequire(import.meta.url),load=Module._load;
Module._load=function(name,...args){return name==='vscode'?{workspace:{getConfiguration:()=>({get:()=>undefined})}}:load.call(this,name,...args);};
const {NodecodeCli,resolveCliBinary,NODECODE_INSTALL_COMMAND}=require('../out/cli.js');
Module._load=load;
async function fixture(run){const root=await mkdtemp(join(tmpdir(),'nodecode-cli-'));try{await run(root);}finally{await rm(root,{recursive:true,force:true});}}

test('finds native installer runtime outside GUI PATH without overriding explicit configuration',()=>fixture(async home=>{
  const dir=join(home,'.local','share','nodecode','current');await mkdir(dir,{recursive:true});
  const binary=join(dir,'nodecode');await writeFile(binary,'#!/bin/sh\necho 1.0\n');await chmod(binary,0o700);
  const options={home,pathEnv:'',platform:process.platform};
  assert.equal(resolveCliBinary('nodecode',options),binary);
  assert.equal(resolveCliBinary(join(home,'missing'),options),undefined);
  assert.equal(resolveCliBinary('another-command',options),undefined);
  assert.equal(resolveCliBinary(dir,options),undefined);
  assert.equal(NODECODE_INSTALL_COMMAND,'curl -fsSL https://nodecode.ai/install.sh | sh');
}));

test('runtime readiness distinguishes missing executable from unreachable gateway',async()=>{
  const cli=new NodecodeCli({current:()=>null,probe:async()=>null,canRestore:false},{log(){}});
  cli.resolve=()=>undefined;
  assert.equal((await cli.ensureReady()).reason,'missing-cli');
  cli.resolve=()=>'/actual/nodecode';cli.readVersion=()=>{cli.version='1.0';return cli.version;};
  assert.equal((await cli.ensureReady()).reason,'gateway-unavailable');
  const ready=new NodecodeCli({current:()=>({baseUrl:'http://127.0.0.1:1234'}),probe:async()=>null},{log(){}});
  ready.resolve=()=>'/actual/nodecode';ready.readVersion=()=>{ready.version='1.0';return ready.version;};
  assert.equal(await ready.ensureReady(),'ok');
});

test('unusable installed executable is reported instead of mistaken for gateway failure',()=>fixture(async home=>{
  const binary=join(home,'nodecode');await writeFile(binary,'#!/bin/sh\nexit 1\n');await chmod(binary,0o700);
  const cli=new NodecodeCli({current:()=>null,probe:async()=>null,canRestore:false},{log(){}});cli.resolve=()=>binary;
  const status=await cli.ensureReady();assert.equal(status.reason,'unusable-cli');assert.match(status.failure,/could not start/);
}));
