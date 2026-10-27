import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire,Module} from 'node:module';
const require=createRequire(import.meta.url),load=Module._load;
const opened=[],warnings=[];
Module._load=function(name,...args){return name==='vscode'?{
  Uri:{file:fsPath=>({fsPath})},Range:class{constructor(...args){this.args=args;}},
  workspace:{openTextDocument:async uri=>{opened.push(uri.fsPath);return {lineCount:20};}},
  window:{showTextDocument:async()=>{},showWarningMessage:message=>warnings.push(message)},
}:load.call(this,name,...args);};
const {SessionPanel}=require('../out/panel.js');Module._load=load;
const {SessionController}=require('../out/manager.js');

test('selected workspace references open the snapshotted root, while session links keep their own cwd',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nodecode-reference-links-'));
  const workspace=path.join(root,'editor'),cwd=path.join(root,'session');
  for(const dir of [workspace,cwd]){fs.mkdirSync(path.join(dir,'src'),{recursive:true});fs.writeFileSync(path.join(dir,'src/same.ts'),dir===workspace?'EDITOR CONTENT':'SESSION CONTENT');}
  const controller=new SessionController({},{log(){}},{},workspace,'cross-folder');
  controller.store.setSessionDetail({session_id:'cross-folder',cwd});
  const panel=Object.create(SessionPanel.prototype);panel.controller=controller;panel.notes={log(){}};
  try{
    const prompt=await controller.withAttachments('Review @src/same.ts',['src/same.ts'],[],{});
    assert.match(prompt,/EDITOR CONTENT/);assert.doesNotMatch(prompt,/SESSION CONTENT/);
    opened.length=0;warnings.length=0;
    await panel.onMessage({type:'openFile',path:'src/same.ts',workspaceReference:true,line:2,endLine:4});
    assert.deepEqual(opened,[fs.realpathSync(path.join(workspace,'src/same.ts'))]);assert.deepEqual(warnings,[]);
    await panel.onMessage({type:'openFile',path:'src/same.ts'});
    assert.deepEqual(opened,[fs.realpathSync(path.join(workspace,'src/same.ts')),fs.realpathSync(path.join(cwd,'src/same.ts'))]);
    await panel.onMessage({type:'openFile',path:'../session/src/same.ts',workspaceReference:true});
    assert.equal(opened.length,2);assert.match(warnings.at(-1),/inside the workspace/);
  }finally{controller.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
