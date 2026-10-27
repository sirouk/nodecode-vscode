import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {SessionController,deleteSessionTree}=require('../out/manager.js');
const {SessionStore}=require('../out/store.js');
const {SessionCache}=require('../out/session-cache.js');
const tick=()=>new Promise(setImmediate);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const replay=(sessionId,resumedAfter)=>({type:'session_stream_resumed',session_id:sessionId,cursor:1,replay_chunk_final:true,admission_state:'ready',...(resumedAfter===undefined?{}:{resumed_after:resumedAfter}),accumulated_frames:[]});
function harness(t,{rows=[{id:'root'}],deletion,historyEventId=async()=> 'event-1',storageRoot}={}){
  const starts=[],controllers=new Map(),children=[];
  const api={sessions:async()=>rows,header:async()=>({}),target:async()=>({}),sessionDetail:async id=>({session_id:id,cwd:'/workspace'}),historyEventId,deleteSession:deletion};
  const cli={spawnRpc(sessionId,cwd,cursor){
    const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;
    child.stdin.once('finish',()=>queueMicrotask(()=>child.emit('close',0,null)));
    starts.push({sessionId,cursor});children.push({sessionId,child});return child;
  }};
  const controller=id=>{const ctl=new SessionController(cli,{log(){}},api,'/workspace',id,storageRoot);controllers.set(id,ctl);return ctl;};
  const emit=(id,frame)=>children.findLast(row=>row.sessionId===id).child.stdout.write(JSON.stringify(frame)+'\n');
  t.after(()=>{for(const ctl of controllers.values())ctl.dispose();});
  return {api,starts,controllers,children,controller,emit};
}
function cache(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nodecode-delete-lifecycle-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const store=new SessionStore();store.applyFrame({...replay('root'),accumulated_frames:[{type:'session_stream_event',sequence:1,session_id:'root',event:{type:'session.created',payload:{id:'root',cwd:'/workspace'}}}]});
  new SessionCache(root,'root',()=>{}).save(1,{sequence:1,eventId:'event-1'},store.snapshotProjection());
  return root;
}

test('deletion blocks re-selection and newly created descendant controllers until accepted deletion disposes them',async t=>{
  const entered=deferred(),result=deferred();
  const h=harness(t,{rows:[{id:'root'},{id:'child',parent_id:'root'},{id:'late',parent_id:'child'},{id:'other'}],deletion:async()=>{entered.resolve();return result.promise;}});
  const root=h.controller('root'),child=h.controller('child'),other=h.controller('other');
  root.connect();child.connect();other.connect();
  const removing=deleteSessionTree(h.api,h.controllers,'root');await entered.promise;
  assert.equal(h.starts.length,3);
  root.connect();child.connect();const late=h.controller('late');late.connect();
  assert.equal(h.starts.length,3,'neither reused nor newly created controllers may subscribe during deletion');
  assert.throws(()=>root.queuePrompt('Do not reopen the reader'),/deletion/);
  assert.equal(other.rpc.connectionState,'connecting','an unrelated reader is untouched');
  result.resolve({sessions:['root','child','late']});assert.deepEqual(await removing,['root','child','late']);
  root.connect();child.connect();late.connect();
  assert.equal(h.starts.length,3,'deleted controllers cannot restart before their registry entries are removed');
});

test('a pending cache witness cannot reopen its reader during or after successful deletion',async t=>{
  const witness=deferred(),entered=deferred(),result=deferred(),storageRoot=cache(t);
  const h=harness(t,{storageRoot,historyEventId:()=>witness.promise,deletion:async()=>{entered.resolve();return result.promise;}});
  const ctl=h.controller('root');assert.equal(ctl.store.cached,true);ctl.connect();
  const removing=deleteSessionTree(h.api,h.controllers,'root');await entered.promise;
  witness.resolve('event-1');await tick();ctl.connect();
  assert.deepEqual(h.starts,[],'witness completion is not permission to reconnect while deleting');
  result.resolve({sessions:['root']});await removing;
  ctl.connect();await tick();assert.deepEqual(h.starts,[]);
  assert.equal(fs.readdirSync(path.join(storageRoot,'session-cache')).length,0);
});

test('a failed deletion releases the gate and reconnects retained and newly selected readers',async t=>{
  const entered=deferred(),result=deferred(),refusal=new Error('session_open');
  const h=harness(t,{rows:[{id:'root'},{id:'child',parent_id:'root'}],deletion:async()=>{entered.resolve();return result.promise;}});
  const root=h.controller('root');root.connect();
  const removing=deleteSessionTree(h.api,h.controllers,'root');await entered.promise;
  const child=h.controller('child');root.connect();child.connect();assert.equal(h.starts.length,1);
  const failed=assert.rejects(removing,error=>error===refusal);result.reject(refusal);await failed;
  assert.deepEqual(h.starts.map(row=>row.sessionId),['root','root','child']);
  h.emit('root',replay('root'));h.emit('child',replay('child'));
  assert.equal(root.rpc.connectionState,'connected');assert.equal(child.rpc.connectionState,'connected');
  root.connect();child.connect();assert.equal(h.starts.length,3,'rollback starts each retained reader only once');
});

test('failed deletion while witness validation is pending still starts one validated connection afterward',async t=>{
  const witness=deferred(),entered=deferred(),result=deferred(),storageRoot=cache(t),refusal=new Error('session_open');
  const h=harness(t,{storageRoot,historyEventId:()=>witness.promise,deletion:async()=>{entered.resolve();return result.promise;}});
  const ctl=h.controller('root');ctl.connect();
  const removing=deleteSessionTree(h.api,h.controllers,'root');await entered.promise;
  const failed=assert.rejects(removing,error=>error===refusal);result.reject(refusal);await failed;
  assert.deepEqual(h.starts,[]);witness.resolve('event-1');await tick();
  assert.deepEqual(h.starts,[{sessionId:'root',cursor:1}]);
});

test('disconnect invalidates running process receipts before notifying views and only fresh native updates reconfirm them',async t=>{
  const h=harness(t),ctl=h.controller('root');ctl.connect();h.emit('root',replay('root'));
  const process=(execId,status,output)=>({type:'session_background_process_updated',session_id:'root',process:{shell_session_id:execId,status,command:'sleep',offset:0,output_b64:Buffer.from(output).toString('base64')}});
  h.emit('root',process(7,'running','last observed'));h.emit('root',process(8,'running','still alive'));h.emit('root',process(9,'exited','finished'));
  let listenerStatuses;ctl.subscribeConnection(state=>{if(state==='disconnected')listenerStatuses=ctl.store.view().processes.map(row=>row.status);});
  h.children.at(-1).child.emit('close',1,null);
  assert.deepEqual(listenerStatuses,['unknown','unknown','exited']);
  assert.throws(()=>ctl.interruptExec(7),/not running/);
  assert.equal(ctl.store.view().processes[0].output,'last observed','uncertain output remains inspectable');
  ctl.connect();h.emit('root',replay('root',1));
  assert.equal(ctl.store.view().processes[0].status,'unknown','cursor catch-up cannot prove a process survived the outage');
  h.emit('root',process(8,'running','still alive'));
  assert.deepEqual(ctl.store.view().processes.map(row=>row.status),['unknown','running','exited']);
  assert.throws(()=>ctl.interruptExec(7),/not running/);
  const sent=ctl.interruptExec(8);assert.ok(sent);
  const wire=JSON.parse(h.children.at(-1).child.stdin.read().toString());assert.equal(wire.exec_id,8);
  h.emit('root',{type:'gateway_turn_command_result',result:{command:'interrupt_exec',command_id:wire.command_id,status:'accepted'}});
  assert.equal((await sent.done).status,'accepted');
});

test('historical running shell results in full or cursor replay remain unconfirmed until a native process update',t=>{
  const h=harness(t),ctl=h.controller('root');ctl.connect();
  const fact={type:'session_stream_event',sequence:2,session_id:'root',turn_id:'turn',event:{type:'turn.tool_result',payload:{'call-id':'shell',metadata:{background_shell:{shell_session_id:7,status:'running',command:'sleep',tail:'historical output'}}}}};
  h.emit('root',{...replay('root'),cursor:2,accumulated_frames:[fact]});
  assert.equal(ctl.store.view().processes[0].status,'unknown','full history does not prove the shell still runs');
  assert.throws(()=>ctl.interruptExec(7),/not running/);
  h.children.at(-1).child.emit('close',1,null);ctl.connect();
  h.emit('root',{...replay('root',2),cursor:3,accumulated_frames:[{...fact,sequence:3}]});
  assert.equal(ctl.store.view().processes[0].status,'unknown','missed tool results during cursor catch-up are historical too');
});

test('a slash result already in flight cannot resync its reader while deletion is pending',async t=>{
  const slash=deferred(),entered=deferred(),result=deferred();
  const h=harness(t,{deletion:async()=>{entered.resolve();return result.promise;}}),ctl=h.controller('root');
  h.api.runSlash=()=>slash.promise;ctl.connect();h.emit('root',replay('root'));
  const running=ctl.runSlash('/undo');
  const removing=deleteSessionTree(h.api,h.controllers,'root');await entered.promise;
  let resyncs=0;ctl.rpc.resync=()=>resyncs++;
  slash.resolve({kind:'ok'});assert.deepEqual(await running,{kind:'ok'});assert.equal(resyncs,0);
  result.resolve({sessions:['root']});await removing;
});
