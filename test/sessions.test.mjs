import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,Module} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
      const controller={
        store:{replayComplete:true,cached:false,replaying:false,view:()=>({activeTurnId:'turn'}),subscribe:()=>({dispose(){}})},
        rpc:{connectionState:'connected'},connect(){},subscribeConnection:()=>({dispose(){}}),
        [method]:()=>method==='navigateCheckpoint'?Promise.resolve(result):result&&{done:Promise.resolve(result)},
      };
      registerSessions({context:{subscriptions:[]},notes:{log(){}},controllerFor:()=>controller});
      await commands.get(command)('session');
      assert.equal(errors.length,result?.status==='accepted'?0:1);
      if(errors.length)assert.match(errors[0],result?/Runtime refused control/:/not connected/i);
    });
  }
});

const {SessionController}=require('../out/manager.js');
const tick=()=>new Promise(setImmediate);
const fact=(sequence,type,turn_id='actual-turn')=>({
  type:'session_stream_event',session_id:'cancel-session',sequence,turn_id,
  event:{type,payload:{},metadata:{event_id:'event-'+sequence}},
});
const replay=(frames=[],extra={})=>({
  type:'session_stream_resumed',session_id:'cancel-session',cursor:frames.at(-1)?.sequence??0,
  replay_chunk_index:0,replay_chunk_final:true,accumulated_frames:frames,...extra,
});
function cancelHarness(t,{root,historyEventId=async()=> 'event-1',spawn=true,status='accepted'}={}){
  errors.length=0;
  const children=[],starts=[],wires=[];
  const emit=(frame,child=children.at(-1))=>child.stdout.write(JSON.stringify({sequence:1,payload:frame})+'\n');
  const cli={spawnRpc(sessionId,cwd,cursor){
    starts.push({sessionId,cwd,cursor});
    if(!spawn)return undefined;
    const child=new EventEmitter();
    child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;
    child.stdin.on('data',data=>{
      const wire=JSON.parse(data.toString());wires.push(wire);
      queueMicrotask(()=>emit({type:'gateway_turn_command_result',result:{
        command:wire.type,command_id:wire.command_id,status:wire.turn_id?status:'rejected',
        ...(!wire.turn_id?{message:'session_id and turn_id required'}:status==='rejected'?{message:'Runtime refused control'}:{}),
      }},child));
    });
    children.push(child);return child;
  }};
  const api={historyEventId,sessionDetail:async()=>({session_id:'cancel-session',cwd:'/workspace'}),
    header:async()=>({}),target:async()=>({}),sessions:async()=>[]};
  const controller=new SessionController(cli,{log(){}},api,'/workspace','cancel-session',root);
  t.after(()=>controller.dispose());
  registerSessions({context:{subscriptions:[]},notes:{log(){}},controllerFor:()=>controller});
  return {controller,children,starts,wires,emit,cancel:()=>commands.get('nodecode.cancelActiveTurn')('cancel-session')};
}

test('cancel connects a cold controller and waits for the final authoritative replay before selecting its turn',async t=>{
  const h=cancelHarness(t),done=h.cancel();
  await tick();
  assert.equal(h.starts.length,1,'the command initiates the session connection');
  assert.equal(h.wires.length,0,'no cancel may be sent before replay');
  h.emit(replay([fact(1,'turn.started','partial-turn')],{replay_chunk_final:false}));
  await tick();assert.equal(h.wires.length,0,'partial replay is not synchronized');
  h.emit(replay([fact(2,'turn.completed','partial-turn'),fact(3,'turn.started')],{replay_chunk_index:1,cursor:3}));
  await done;
  assert.equal(h.wires.length,1);assert.equal(h.wires[0].type,'cancel_turn');
  assert.equal(h.wires[0].session_id,'cancel-session');assert.equal(h.wires[0].turn_id,'actual-turn');
  assert.deepEqual(errors,[]);
});

test('cancel waits through cached witness validation and uses the live turn rather than the cached one',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nodecode-cancel-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const first=cancelHarness(t,{root});first.controller.connect();first.emit(replay([fact(1,'turn.started','cached-turn')]));first.controller.dispose();
  let resolveWitness;
  const witness=new Promise(resolve=>{resolveWitness=resolve;});
  const h=cancelHarness(t,{root,historyEventId:()=>witness});
  assert.equal(h.controller.store.cached,true);
  const done=h.cancel();await tick();
  assert.equal(h.starts.length,0);assert.equal(h.wires.length,0);
  resolveWitness('event-1');await tick();
  assert.equal(h.starts.length,1);assert.equal(h.starts[0].cursor,1);assert.equal(h.wires.length,0);
  h.emit(replay([fact(2,'turn.completed','cached-turn'),fact(3,'turn.started','live-turn')],{resumed_after:1,cursor:3}));
  await done;
  assert.equal(h.wires.length,1);assert.equal(h.wires[0].turn_id,'live-turn');assert.deepEqual(errors,[]);
});

test('cancel reports no active turn after synchronization without sending an invalid control command',async t=>{
  const h=cancelHarness(t),done=h.cancel();await tick();
  assert.equal(h.wires.length,0);h.emit(replay([],{admission_state:'ready'}));await done;
  assert.equal(h.wires.length,0);assert.equal(errors.length,1);assert.match(errors[0],/no active turn/i);
});

test('cancel surfaces connection failure without sending a control command',async t=>{
  const h=cancelHarness(t,{spawn:false});await h.cancel();
  assert.equal(h.starts.length,1);assert.equal(h.wires.length,0);
  assert.equal(errors.length,1);assert.match(errors[0],/not connected.*synchronization failed/i);
});

test('cancel waits through a replay disconnect instead of using a retained turn id',async t=>{
  const h=cancelHarness(t);h.controller.connect();h.emit(replay([fact(1,'turn.started','old-turn')]));
  h.children[0].emit('close',1,null);
  const done=h.cancel();await tick();
  assert.equal(h.children.length,2);assert.equal(h.wires.length,0);
  h.emit(replay([],{resumed_after:1,admission_state:'ready'}));await done;
  assert.equal(h.wires.length,0);assert.equal(errors.length,1);assert.match(errors[0],/no active turn/i);
});

test('cancel surfaces native rejection after cold synchronization',async t=>{
  const h=cancelHarness(t,{status:'rejected'}),done=h.cancel();await tick();h.emit(replay([fact(1,'turn.started')]));await done;
  assert.equal(h.wires.length,1);assert.equal(h.wires[0].turn_id,'actual-turn');
  assert.equal(errors.length,1);assert.match(errors[0],/Runtime refused control/);
});

test('cancel synchronization wait times out, removes listeners, and cannot cancel after late replay',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const h=cancelHarness(t),done=h.cancel();
  await Promise.resolve();await Promise.resolve();
  assert.equal(h.starts.length,1);assert.equal(h.wires.length,0);
  assert.equal(h.controller.connectionListeners.size,1);
  t.mock.timers.tick(30000);await done;
  assert.equal(errors.length,1);assert.match(errors[0],/did not finish synchronizing/);
  assert.equal(h.controller.connectionListeners.size,0);
  h.emit(replay([fact(1,'turn.started')]));await Promise.resolve();
  assert.equal(h.wires.length,0,'late synchronization must not apply an abandoned cancellation');
});
