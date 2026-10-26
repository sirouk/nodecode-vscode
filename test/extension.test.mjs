import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,Module} from 'node:module';
const require=createRequire(import.meta.url),load=Module._load;
let callbacks,api;
const terminalFailure=new Error('terminal unavailable');
const uri=fsPath=>({scheme:'file',fsPath,toString:()=>fsPath});
const disposable=()=>({dispose(){}});
const vscode={
  StatusBarAlignment:{Left:1},MarkdownString:class{},
  window:{
    createStatusBarItem:()=>({show(){},dispose(){}}),
    registerWebviewViewProvider:()=>disposable(),
    showQuickPick:async rows=>rows[1],
    terminals:[],createTerminal:()=>{throw terminalFailure;},
  },
  workspace:{workspaceFolders:[{uri:uri('/workspace')}]},
  commands:{registerCommand:()=>disposable()},
};
class Api{constructor(){api=this;}async sessions(){return [];}}
const mocks={
  './api':{NodecodeApi:Api},
  './cli':{NodecodeCli:class{version='test';resolve(){return '/nodecode';}async ensureReady(){return 'ok';}}},
  './discovery':{
    Notifications:class{log(){}},
    NodecodeDiscovery:class{watch(){}onDidChange(){return disposable();}current(){return null;}},
  },
  './panel':{SessionPanel:{},SessionSidebar:class{constructor(_uri,actions){callbacks=actions;}}},
  './sessions':{registerSessions(){}},
};
Module._load=function(name,parent,...args){
  if(name==='vscode')return vscode;
  if(parent?.filename.endsWith('/out/extension.js')&&mocks[name])return mocks[name];
  return load.call(this,name,parent,...args);
};
const {activate}=require('../out/extension.js');
Module._load=load;
const state={get:(_key,fallback)=>fallback,update:async()=>{}};
activate({subscriptions:[],globalState:state,workspaceState:state,extensionUri:uri('/extension')});

test('native panel model picker preserves provider identity and supports cancellation',async()=>{
  const calls=[];
  api.models=async()=>[
    {provider:'alpha',model:'shared',display_name:'Shared model'},
    {provider:'beta',model:'shared',display_name:'Shared model'},
  ];
  api.setModel=async(...args)=>calls.push(args);
  await callbacks.pickModel('session',{});
  assert.deepEqual(calls,[['session','beta','shared']]);
  vscode.window.showQuickPick=async()=>undefined;
  await callbacks.pickModel('session',{});
  assert.equal(calls.length,1);
});

test('native action callbacks return their asynchronous failures to the caller',async t=>{
  for(const [callback,method] of [
    ['forkSession','forkSession'],['exportSession','exportJsonl'],
    ['showCheckpointHistory','checkpoints'],['pickModel','models'],['pickEffort','target'],
  ])await t.test(callback,async()=>{
    const failure=new Error(`${method} unavailable`);
    api[method]=async()=>{throw failure;};
    const result=callbacks[callback]('session',{});
    assert.equal(typeof result?.then,'function','callback must return its work');
    await assert.rejects(result,error=>error===failure);
  });
  await assert.rejects(callbacks.revealTerminal('session'),error=>error===terminalFailure);
});


test('native checkpoint picker reports a missing or rejected acknowledgement',async()=>{
  api.checkpoints=async()=>[{turn_id:'recorded-turn',prompt:'Restore point'}];
  vscode.window.showQuickPick=async rows=>rows[0];
  for(const result of [undefined,{status:'rejected',message:'Checkpoint restore refused'},{status:'accepted'}]){
    const controller={navigateCheckpoint:async options=>{
      assert.deepEqual(options,{targetTurnId:'recorded-turn'});return result;
    }};
    const action=callbacks.showCheckpointHistory('session',controller);
    if(result?.status==='accepted')await action;
    else await assert.rejects(action,result?/Checkpoint restore refused/:/not connected/i);
  }
});
