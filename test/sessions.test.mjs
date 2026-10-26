import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,Module} from 'node:module';
const require=createRequire(import.meta.url),load=Module._load;
const commands=new Map();
let choose;
const errors=[];
const vscode={
  Disposable:{from:()=>({dispose(){}})},
  commands:{registerCommand:(id,fn)=>{commands.set(id,fn);return {dispose(){}};}},
  window:{showQuickPick:(...args)=>choose(...args),showErrorMessage:message=>errors.push(message)},
};
Module._load=function(name,...args){return name==='vscode'?vscode:load.call(this,name,...args);};
const {registerSessions}=require('../out/sessions.js');
Module._load=load;

test('model command uses the selected row identity, not a possibly duplicated label',async()=>{
  const calls=[];
  const models=[
    {provider:'alpha',model:'shared',display_name:'Shared model'},
    {provider:'beta',model:'shared',display_name:'Shared model'},
  ];
  choose=async rows=>rows[1];
  registerSessions({context:{subscriptions:[]},notes:{log(){}},api:{
    models:async()=>models,
    setModel:async(...args)=>calls.push(args),
  }});
  await commands.get('nodecode.pickModel')('session');
  assert.deepEqual(calls,[['session','beta','shared']]);
  choose=async()=>undefined;
  await commands.get('nodecode.pickModel')('session');
  assert.equal(calls.length,1);
});


test('native cancel and undo commands surface disconnected and rejected results',async t=>{
  for(const [command,method] of [['nodecode.cancelActiveTurn','cancelActive'],['nodecode.undoLastTurn','navigateCheckpoint']]){
    for(const result of [undefined,{status:'rejected',message:'Runtime refused control'},{status:'accepted'}])await t.test(`${command} ${result?.status||'disconnected'}`,async()=>{
      errors.length=0;
      const controller={store:{view:()=>({activeTurnId:'turn'})},[method]:()=>method==='navigateCheckpoint'?Promise.resolve(result):result&&{done:Promise.resolve(result)}};
      registerSessions({context:{subscriptions:[]},notes:{log(){}},controllerFor:()=>controller});
      await commands.get(command)('session');
      assert.equal(errors.length,result?.status==='accepted'?0:1);
      if(errors.length)assert.match(errors[0],result?/Runtime refused control/:/not connected/i);
    });
  }
});
