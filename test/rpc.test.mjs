import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { RpcProcess } = require('../out/rpc.js');
const { SessionController } = require('../out/manager.js');
function harness() {
  const children = [], starts = [];
  const cli = { spawnRpc(sessionId,cwd,cursor) {
    starts.push({sessionId,cwd,cursor});
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => true;
    children.push(child);
    return child;
  }};
  const rpc = new RpcProcess(cli, {log(){}}, process.cwd(), 'session');
  return {rpc, children, starts};
}
function emit(child, payload) { child.stdout.write(JSON.stringify({sequence: 1, payload}) + '\n'); }

test('turn commands use the native request envelope and control commands stay flat', async () => {
  const {rpc, children} = harness();
  rpc.start();
  const commands = [
    {type:'start_turn', prompt:'hello', content:[{type:'text',text:'hello'}]},
    {type:'steer_turn', expected_turn_id:'turn', prompt:'adjust'},
    {type:'cancel_turn', turn_id:'turn'},
  ];
  try {
    for (const command of commands) {
      const sent = rpc.sendCommand(command);
      const wire = JSON.parse(children[0].stdin.read().toString());
      const {type, ...fields} = command;
      assert.deepEqual(wire, type === 'cancel_turn'
        ? {type, command_id:sent.commandId, ...fields, session_id:'session'}
        : {type, command_id:sent.commandId, request:{...fields, session_id:'session'}});
      emit(children[0], {type:'gateway_turn_command_result', result:{command:type, command_id:sent.commandId, status:'accepted'}});
      assert.equal((await sent.done).status, 'accepted');
    }
  } finally {rpc.dispose();}
});

test('native protocol errors reject pending submission immediately with the actual cause', async () => {
  const {rpc, children} = harness();
  try {
    rpc.start();
    const sent = rpc.sendCommand({type:'start_turn',prompt:'hello'});
    emit(children[0], {type:'sync_protocol_error',code:'invalid-envelope',message:'request must be an object',permanent:false});
    const result = await sent.done;
    assert.equal(result.status, 'rejected');
    assert.match(result.message, /request must be an object/);
    assert.equal(result.command_id, sent.commandId);
  } finally {rpc.dispose();}
});

test('disconnect rejects pending commands rather than leaving composer waiting', async () => {
  const {rpc,children} = harness();
  rpc.start();
  const sent = rpc.sendCommand({type: 'start_turn', prompt: 'test'});
  children[0].emit('close', 1, null);
  const result = await sent.done;
  assert.equal(result.status, 'rejected');
  rpc.dispose();
});

test('late exit from previous child cannot disconnect replacement transport', async () => {
  const {rpc,children} = harness();
  try {
    rpc.start();
    emit(children[0], {type: 'session_stream_resumed', session_id: 'session', accumulated_frames: []});
    rpc.resync();
    await delay(20);
    assert.equal(children.length, 2);
    emit(children[1], {type: 'session_stream_resumed', session_id: 'session', accumulated_frames: []});
    children[0].emit('exit', 0, null);
    assert.equal(rpc.connectionState, 'connected');
    const sent = rpc.sendCommand({type: 'start_turn', prompt: 'test'});
    emit(children[1], {type: 'gateway_turn_command_result', result: {command: 'start_turn', command_id: sent.commandId, status: 'accepted'}});
    assert.equal((await sent.done).status, 'accepted');
  } finally {rpc.dispose();}
});

test('model invalidation refreshes the focused session target', async () => {
  const requested = [];
  const controller = new SessionController({}, {log(){}}, {target: async id => {requested.push(id);return {model:'new-model', provider:'provider', effort:'high'};}}, process.cwd(), 'focused');
  try {
    controller.rpc.onFrame({type:'model_changed'});
    await delay(0);
    assert.deepEqual(requested, ['focused']);
    assert.equal(controller.store.view().model, 'new-model');
    assert.equal(controller.store.view().effort, 'high');
  } finally {controller.dispose();}
});

test('native image messages serialize content and reject unsupported files', () => {
  const controller = new SessionController({}, {log(){}}, {}, process.cwd(), 'focused');
  const commands = [];
  controller.rpc.sendCommand = command => {commands.push(command); return undefined;};
  try {
    controller.sendPrompt('Describe', [{mediaType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZcToAAAAASUVORK5CYII='}]);
    assert.deepEqual(commands[0], {type:'start_turn',prompt:'Describe',content:[{type:'text',text:'Describe'},{type:'image',source:{type:'base64',media_type:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZcToAAAAASUVORK5CYII='}}]});
    assert.throws(() => controller.sendPrompt('Bad', [{mediaType:'image/svg+xml',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZcToAAAAASUVORK5CYII='}]), /PNG/);
    assert.equal(commands.length, 1);
  } finally {controller.dispose();}
});

test('graceful stop waits for CLI closure and does not restart the reader', async () => {
  const {rpc,children} = harness();
  rpc.start();
  emit(children[0], {type:'session_stream_resumed',session_id:'session',accumulated_frames:[]});
  let finished = false;
  const closing = rpc.stopAndWait().then(() => {finished = true;});
  await delay(10);
  assert.equal(finished, false);
  assert.equal(children[0].stdin.writableEnded, true);
  children[0].emit('exit', 0, null);
  children[0].emit('close', 0, null);
  await closing;
  assert.equal(rpc.connectionState, 'disconnected');
  await delay(20);
  assert.equal(children.length, 1);
  rpc.dispose();
});

test('session deletion releases only the requested tree before deleting', async () => {
  const {deleteSessionTree} = require('../out/manager.js');
  const calls = [];
  const controllers = new Map(['root','child','grandchild','other'].map(id => [id, {
    rpc:{stopAndWait:async () => {await delay(1);calls.push('close:'+id);}},
    connect(){calls.push('reconnect:'+id);},
  }]));
  const api = {
    sessions: async () => [{id:'grandchild',parent_id:'child'},{id:'other'},{id:'child',parent_id:'root'},{id:'root'}],
    deleteSession: async id => {calls.push('delete:'+id);return {sessions:['root','child','grandchild']};},
  };
  assert.deepEqual(await deleteSessionTree(api,controllers,'root'), ['root','child','grandchild']);
  assert.deepEqual(calls, ['close:root','close:child','close:grandchild','delete:root']);
});

test('a foreign shell refusal restores owned readers without bypassing the refusal', async () => {
  const {deleteSessionTree} = require('../out/manager.js');
  const calls = [];
  const controller = {rpc:{stopAndWait:async()=>calls.push('close')},connect(){calls.push('reconnect');}};
  const refusal = new Error('session_open');
  const api = {sessions:async()=>[{id:'root'}],deleteSession:async()=>{calls.push('delete');throw refusal;}};
  await assert.rejects(deleteSessionTree(api,new Map([['root',controller]]),'root'), error => error === refusal);
  assert.deepEqual(calls,['close','delete','reconnect']);
});

test('command identity cannot collide across fresh RPC attachments', async () => {
  const first=harness(), second=harness();
  try {
    first.rpc.start();second.rpc.start();
    const a=first.rpc.sendCommand({type:'get_state'}), b=second.rpc.sendCommand({type:'get_state'});
    assert.notEqual(a.commandId,b.commandId);
    assert.match(a.commandId,/^vscode-[a-f0-9-]{36}$/);
    emit(first.children[0],{type:'gateway_turn_command_result',result:{command:'get_state',command_id:a.commandId,status:'accepted'}});
    emit(second.children[0],{type:'gateway_turn_command_result',result:{command:'get_state',command_id:b.commandId,status:'accepted'}});
    await Promise.all([a.done,b.done]);
  } finally {first.rpc.dispose();second.rpc.dispose();}
});

test('image-only prompts remain admissible and binary files cannot masquerade as images', () => {
  const controller=new SessionController({}, {log(){}}, {}, process.cwd(), 'image-only');
  const commands=[];controller.rpc.sendCommand=command=>{commands.push(command);};
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZcToAAAAASUVORK5CYII=';
  controller.sendPrompt('',[{mediaType:'image/png',data:png},{mediaType:'image/png',data:png}]);
  assert.equal(commands[0].content.length,3);
  assert(commands[0].prompt.length>0);
  assert.throws(()=>controller.sendPrompt('bad',[{mediaType:'image/png',data:Buffer.from('not an image').toString('base64')}]),/format/);
  assert.equal(commands.length,1);
  controller.dispose();
});

test('slash control stays on native API and refreshes only affected session state',async()=>{
  const calls=[];
  const api={runSlash:async(line,id)=>{calls.push(['slash',line,id]);return{text:'done'};},header:async()=>({}),target:async()=>({}),sessions:async()=>[]};
  const controller=new SessionController({}, {log(){}},api,process.cwd(),'slash-session');
  controller.rpc.sendCommand=()=>{throw Error('slash must never become a model prompt');};
  controller.rpc.resync=()=>calls.push(['resync']);
  try{
    assert.equal((await controller.runSlash('/help')).text,'done');
    assert.deepEqual(calls,[['slash','/help','slash-session']]);
    await controller.runSlash('/clear');
    assert.deepEqual(calls.at(-1),['resync']);
    await assert.rejects(controller.runSlash('ordinary prompt'),/slash command/);
  }finally{controller.dispose();}
});

test('reconnect uses last durable cursor and ignores replaced child output',async()=>{
  const {rpc,children,starts}=harness(),frames=[];rpc.onFrame=frame=>frames.push(frame);
  try{
    rpc.start();
    emit(children[0],{type:'session_stream_resumed',session_id:'session',cursor:100,accumulated_frames:[],replay_chunk_final:true});
    emit(children[0],{type:'session_stream_event',frame:{seq:108,session_id:'session',event:{type:'turn.completed',payload:{}}}});
    children[0].emit('close',1,null);await delay(280);
    assert.equal(starts[1].cursor,108);
    emit(children[1],{type:'session_stream_resumed',session_id:'session',resumed_after:108,cursor:108,accumulated_frames:[],replay_chunk_final:true});
    const count=frames.length;
    emit(children[0],{type:'session_stream_resumed',session_id:'stale',cursor:900,accumulated_frames:[]});
    assert.equal(frames.length,count);
    rpc.resync();await delay(20);
    assert.equal(starts[2].cursor,undefined);
  }finally{rpc.dispose();}
});

test('ready waits for final replay and complete frames drain after process exit',async()=>{
  const {rpc,children}=harness();
  try{
    rpc.start();
    emit(children[0],{type:'session_stream_resumed',session_id:'session',replay_tail:true,replay_chunk_final:true,accumulated_frames:[]});
    assert.notEqual(rpc.connectionState,'connected');
    emit(children[0],{type:'session_stream_resumed',session_id:'session',replay_chunk_final:false,accumulated_frames:[]});
    assert.notEqual(rpc.connectionState,'connected');
    emit(children[0],{type:'session_stream_resumed',session_id:'session',cursor:0,replay_chunk_final:true,accumulated_frames:[]});
    assert.equal(rpc.connectionState,'connected');
    const sent=rpc.sendCommand({type:'get_state'});
    children[0].emit('exit',0,null);
    emit(children[0],{type:'gateway_turn_command_result',result:{command:'get_state',command_id:sent.commandId,status:'accepted'}});
    assert.equal((await sent.done).status,'accepted');
    children[0].emit('close',0,null);
  }finally{rpc.dispose();}
});

test('spawn failure before first replay retries and disposal cannot resurrect transport',async()=>{
  const {rpc,children}=harness();rpc.start();
  children[0].emit('error',new Error('temporary spawn failure'));
  children[0].emit('close',-2,null);
  await delay(280);assert.equal(children.length,2);
  rpc.dispose();rpc.start();rpc.resync();
  assert.equal(rpc.sendCommand({type:'get_state'}),undefined);
  await delay(20);assert.equal(children.length,2);
});

test('connect while graceful detach is closing cannot revive its child',async()=>{
  const {rpc,children}=harness();rpc.start();
  const stopped=rpc.stopAndWait();rpc.start();
  assert.equal(rpc.sendCommand({type:'get_state'}),undefined);
  children[0].emit('close',0,null);await stopped;
  await delay(280);assert.equal(children.length,1);rpc.dispose();
});

test('uncorrelated command reply cannot acknowledge a pending request',async()=>{
  const {rpc,children}=harness();
  try{
    rpc.start();const sent=rpc.sendCommand({type:'get_state'});let settled=false;sent.done.then(()=>settled=true);
    emit(children[0],{type:'gateway_turn_command_result',result:{command:'get_state',status:'accepted'}});
    await delay(0);assert.equal(settled,false);
    children[0].emit('close',1,null);
    const outcome=await sent.done;assert.equal(outcome.code,'acknowledgement_unknown');assert.match(outcome.message,/outcome unknown/);
  }finally{rpc.dispose();}
});

test('malformed output recovers from last cursor without consuming later bytes',async()=>{
  const {rpc,children,starts}=harness();let facts=0;rpc.onFrame=f=>{if(f.type==='session_stream_event')facts++;};
  try{
    rpc.start();emit(children[0],{type:'session_stream_resumed',cursor:7,accumulated_frames:[]});
    children[0].stdout.write('not JSON\n'+JSON.stringify({type:'session_stream_event',sequence:100,event:{type:'turn.completed',payload:{}}})+'\n');
    assert.equal(facts,0);await delay(280);assert.equal(starts[1].cursor,7);
  }finally{rpc.dispose();}
});

test('stale controller refreshes cannot overwrite newer state or update after dispose',async()=>{
  const targets=[],headers=[];
  const controller=new SessionController({}, {log(){}}, {target:()=>new Promise(resolve=>targets.push(resolve)),header:()=>new Promise(resolve=>headers.push(resolve))},process.cwd(),'s');
  controller.refreshTarget();controller.refreshTarget();
  targets[1]({model:'new',provider:'p'});targets[0]({model:'old',provider:'p'});await delay(0);
  assert.equal(controller.store.view().model,'new');
  controller.refreshHeader();controller.dispose();headers[0]({title:'late'});await delay(0);
  assert.notEqual(controller.store.view().title,'late');
});

test('interrupted replacement full replay cannot resume from an obsolete branch cursor',async()=>{
  const {rpc,children,starts}=harness();
  try{
    rpc.start();emit(children[0],{type:'session_stream_resumed',session_id:'session',cursor:100,accumulated_frames:[]});
    children[0].emit('close',1,null);await delay(280);assert.equal(starts[1].cursor,100);
    emit(children[1],{type:'session_stream_resumed',session_id:'session',resumed_after:null,replay_chunk_index:0,replay_chunk_final:false,accumulated_frames:[]});
    children[1].emit('close',1,null);await delay(550);assert.equal(starts[2].cursor,undefined);
  }finally{rpc.dispose();}
});

test('UTF-8 split across stream chunks preserves native text',()=>{
  const {rpc,children}=harness(),frames=[];rpc.onFrame=frame=>frames.push(frame);
  try{
    rpc.start();const wire=Buffer.from(JSON.stringify({type:'item_delta',delta:{type:'text',text:'hello 😀'}})+'\n');
    const split=wire.indexOf(Buffer.from('😀'))+2;
    children[0].stdout.write(wire.subarray(0,split));children[0].stdout.write(wire.subarray(split));
    assert.equal(frames[0].delta.text,'hello 😀');
  }finally{rpc.dispose();}
});

test('native indexed replay omits final marker until completion and cannot publish partial cursor',async()=>{
  const {rpc,children,starts}=harness();
  try{
    rpc.start();
    emit(children[0],{type:'session_stream_resumed',session_id:'session',replay_chunk_index:0,accumulated_frames:[{seq:10,event:{type:'turn.started',payload:{}}}]});
    assert.notEqual(rpc.connectionState,'connected');
    children[0].emit('close',1,null);await delay(280);
    assert.equal(starts[1].cursor,undefined);
    emit(children[1],{type:'session_stream_resumed',session_id:'session',replay_chunk_index:0,accumulated_frames:[]});
    emit(children[1],{type:'session_stream_resumed',session_id:'session',replay_chunk_index:1,replay_chunk_final:true,cursor:20,accumulated_frames:[]});
    assert.equal(rpc.connectionState,'connected');
  }finally{rpc.dispose();}
});
