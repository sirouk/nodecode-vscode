import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire,Module} from 'node:module';
const require=createRequire(import.meta.url),load=Module._load;
const terminals=[];
Module._load=function(name,...args){
  return name==='vscode'?{
    workspace:{getConfiguration:()=>({get:()=>undefined})},
    window:{createTerminal:(options)=>{const terminal={options,lines:[],show(){},sendText(text){this.lines.push(text);}};terminals.push(terminal);return terminal;},showErrorMessage:async()=>undefined},
  }:load.call(this,name,...args);
};
const {NodecodeCli,resolveCliBinary,installCommand,NODECODE_INSTALL_COMMAND}=require('../out/cli.js');
Module._load=load;
const notes={lines:[],log(line){this.lines.push(line);}};
const cliFor=(binary)=>{const cli=new NodecodeCli({current:()=>null,probe:async()=>null},{log(){}});cli.resolve=()=>binary;return cli;};
async function fixture(run){const root=await mkdtemp(join(tmpdir(),'nodecode-cli-'));try{return await run(root);}finally{await rm(root,{recursive:true,force:true});}}
async function script(root,body){
  const file=join(root,'nodecode');await writeFile(file,`#!/bin/sh\n${body}\n`);await chmod(file,0o700);return file;
}

test('finds the native install outside a GUI PATH, without overriding explicit configuration',()=>fixture(async home=>{
  const dir=join(home,'.local','share','nodecode','current');await mkdir(dir,{recursive:true});
  const binary=join(dir,'nodecode');await writeFile(binary,'#!/bin/sh\necho 1.0\n');await chmod(binary,0o700);
  const options={home,pathEnv:'',platform:process.platform};
  assert.equal(resolveCliBinary('nodecode',options),binary);
  assert.equal(resolveCliBinary(join(home,'missing'),options),undefined);
  assert.equal(resolveCliBinary('another-command',options),undefined);
  assert.equal(resolveCliBinary(dir,options),undefined);
  assert.equal(NODECODE_INSTALL_COMMAND,'curl -fsSL https://nodecode.ai/install.sh | sh');
  assert.match(installCommand('win32'),/install\.ps1/);
  assert.match(installCommand('darwin'),/install\.sh \| sh/);
}));

test('the version is read, and a binary that will not start says why',()=>fixture(async root=>{
  const good=cliFor(await script(root,'echo nodecode 0.1.14+abc'));
  assert.equal(good.readVersion(good.resolve()),'nodecode 0.1.14+abc');
  assert.equal(good.versionError(),'');
  const broken=cliFor(await script(root,'exit 3'));
  assert.equal(broken.readVersion(broken.resolve()),'unknown');
  assert.notEqual(broken.versionError(),'');
}));

test('a command answers with its exit code and both streams, and never throws',()=>fixture(async root=>{
  const cli=cliFor(await script(root,'echo out; echo err 1>&2; exit 4'));
  const result=await cli.run(['gateway','status']);
  assert.equal(result.code,4);
  assert.equal(result.stdout.trim(),'out');
  assert.equal(result.stderr.trim(),'err');
  assert.equal((await cliFor(undefined).run(['web','--print'])).code,-1);
}));

test('the page link is read from web --print, and its absence is not a crash',()=>fixture(async root=>{
  const link='http://127.0.0.1:50171/web/#t=abcdef';
  const cli=cliFor(await script(root,`echo "warning: something"; echo "${link}"`));
  assert.equal(await cli.webLink(),link);
  const silent=cliFor(await script(root,'echo "the web cell is off"; exit 1'));
  assert.equal(await silent.webLink(),undefined);
}));

test('turning the web cell on asks for the shipped cell, answered on the line',()=>fixture(async root=>{
  const cli=cliFor(await script(root,'for arg in "$@"; do printf "%s\\n" "$arg"; done'));
  const result=await cli.enableWebCell();
  assert.equal(result.code,0);
  assert.deepEqual(result.stdout.trim().split('\n'),['add','nc://web','--yes','--wait','120']);
  assert.deepEqual((await cli.startGateway()).stdout.trim().split('\n'),['gateway','on']);
}));

test('installing runs the official installer in a terminal the operator can watch',()=>{
  terminals.length=0;
  new NodecodeCli({},notes).installInTerminal();
  assert.equal(terminals.length,1);
  assert.equal(terminals[0].lines[0],installCommand());
  assert.equal(terminals[0].options.name,'Install Nodecode');
});

test('a Windows command shim is started through cmd, and a native binary is not',()=>{
  const {spawnPlan}=require('../out/cli.js');
  assert.deepEqual(spawnPlan('/usr/bin/nodecode',['--version'],'darwin'),{file:'/usr/bin/nodecode',args:['--version']});
  assert.deepEqual(spawnPlan('C:\\Program Files\\nodecode\\nodecode.exe',['web'],'win32'),{file:'C:\\Program Files\\nodecode\\nodecode.exe',args:['web']});
  const plan=spawnPlan('C:\\Users\\me\\AppData\\Roaming\\npm\\nodecode.cmd',['web','--print'],'win32','C:\\Windows\\System32\\cmd.exe');
  assert.equal(plan.file,'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(plan.args.slice(0,3),['/d','/s','/c']);
  assert.equal(plan.args[3],'""C:\\Users\\me\\AppData\\Roaming\\npm\\nodecode.cmd" "web" "--print""','every part is quoted, and cmd unwraps the outer pair');
  assert.match(spawnPlan('C:\\x\\nodecode.BAT',[],'win32').args[3],/^""C:\\x\\nodecode\.BAT""$/);
});

test('the version is read once per binary, and a binary replaced in place is read again',()=>fixture(async root=>{
  const {readFile}=await import('node:fs/promises');
  const marker=join(root,'calls');
  const file=join(root,'nodecode');
  await writeFile(file,`#!/bin/sh\necho call >> ${marker}\necho nodecode 0.1.14\n`);await chmod(file,0o700);
  const cli=cliFor(file);
  assert.equal(cli.readVersion(file),'nodecode 0.1.14');
  assert.equal(cli.readVersion(file),'nodecode 0.1.14');
  assert.equal((await readFile(marker,'utf8')).trim().split('\n').length,1,'a poll does not start a process every tick');
  await writeFile(file,`#!/bin/sh\necho call >> ${marker}\necho nodecode 0.1.15-dev\n`);await chmod(file,0o700);
  assert.equal(cli.readVersion(file),'nodecode 0.1.15-dev','an update in place is read, not remembered');
}));

test('a version that could not be read is asked again, so an install is not remembered as broken',()=>fixture(async root=>{
  const file=join(root,'nodecode');
  await writeFile(file,'#!/bin/sh\nexit 3\n');await chmod(file,0o700);
  const cli=cliFor(file);
  assert.equal(cli.readVersion(file),'unknown');
  assert.notEqual(cli.versionError(),'');
  await writeFile(file,'#!/bin/sh\necho nodecode 0.2.0\n');await chmod(file,0o700);
  assert.equal(cli.readVersion(file),'nodecode 0.2.0');
  assert.equal(cli.versionError(),'','the failure does not outlive the binary that caused it');
}));
