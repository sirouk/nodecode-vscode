import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {SessionCache}=require('../out/session-cache.js');
const {SessionController}=require('../out/manager.js');
const {SessionStore}=require('../out/store.js');
const tick=()=>new Promise(setImmediate);
const fact=(seq,type,payload={},turn_id='turn')=>({seq,session_id:'saved',turn_id,event:{type,payload,metadata:{event_id:'event-'+seq}}});
const full=(frames,cursor=frames.at(-1)?.seq??0)=>({type:'session_stream_resumed',session_id:'saved',admission_state:'ready',replay_chunk_index:0,replay_chunk_final:true,cursor,accumulated_frames:frames});
const base=[fact(1,'session.created',{id:'saved',cwd:'/workspace'}),fact(2,'turn.started'),fact(3,'turn.input_committed',{message:'Original prompt',disposition:'started','prompt-id':'first'}),fact(4,'turn.usage',{'input-tokens':1000,'output-tokens':100,'cached-input-tokens':2000,'cache-write-tokens':300}),fact(5,'turn.completed')];
function harness(root,historyEventId=async(_,seq)=>'event-'+seq){
  const children=[],starts=[],logs=[];
  const cli={spawnRpc(sessionId,cwd,cursor){
    starts.push({sessionId,cursor});const child=new EventEmitter();
    child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;children.push(child);return child;
  }};
  // Usage is omitted until an authoritative HTTP header is available; replay supplies it here.
  const api={historyEventId,sessionDetail:async()=>({session_id:'saved',cwd:'/workspace',standby:false}),header:async()=>({session_id:'saved'}),target:async()=>({}),sessions:async()=>[{id:'saved',title:'Saved'},{id:'agent',parent_id:'saved',source:'fork',title:'Agent'}]};
  const ctl=new SessionController(cli,{log:message=>logs.push(message)},api,'/workspace','saved',root);
  const emit=frame=>children.at(-1).stdout.write(JSON.stringify({sequence:999999,payload:frame})+'\n');
  return {ctl,emit,children,starts,logs};
}
function temporary(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'nodecode-cache-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function checkpoint(root){const files=fs.readdirSync(path.join(root,'session-cache'));assert.equal(files.length,1);return path.join(root,'session-cache',files[0]);}

test('a reopened controller shows complete saved history immediately, validates one fact, and resumes only the suffix',async t=>{
  const root=temporary(t),first=harness(root);first.ctl.connect();first.emit(full(base,8));await tick();
  const expected=structuredClone(first.ctl.store.view());first.ctl.dispose();
  const saved=JSON.parse(fs.readFileSync(checkpoint(root),'utf8'));
  assert.equal(saved.cursor,8,'preserve the final cursor even beyond the last visible fact');assert.deepEqual(saved.witness,{sequence:5,eventId:'event-5'});
  let resolve,validationCalls=0;const validation=new Promise(done=>resolve=done);
  const next=harness(root,async(id,seq)=>{assert.equal(id,'saved');assert.equal(seq,5);validationCalls++;return validation;});t.after(()=>next.ctl.dispose());
  const view=next.ctl.store.view();assert.equal(view.cached,true);assert.equal(view.replayComplete,false);
  for(const key of ['parts','totals','contextUsage','modifiedFiles','descendants'])assert.deepEqual(view[key],expected[key],key);
  next.ctl.connect();next.ctl.connect();assert.equal(validationCalls,1);assert.equal(next.starts.length,0);
  resolve('event-5');await tick();assert.deepEqual(next.starts,[{sessionId:'saved',cursor:8}]);
  next.emit({...full([fact(9,'turn.started',{},'second'),fact(10,'turn.input_committed',{message:'New prompt',disposition:'started','prompt-id':'second'},'second'),fact(11,'turn.usage',{'input-tokens':400,'output-tokens':20}),fact(12,'turn.completed')],12),resumed_after:8});
  assert.deepEqual(next.ctl.store.userPrompts(),['Original prompt','New prompt']);assert.equal(next.ctl.store.view().totals.total,3820);
  assert.equal(next.ctl.store.view().cached,false);assert.equal(next.ctl.store.view().replayComplete,true);
});

test('a changed or unavailable history witness requests authoritative replacement instead of cursor resume',async t=>{
  for(const validate of [async()=> 'different-event',async()=>undefined,async()=>{throw new Error('offline');}]){
    const root=temporary(t),first=harness(root);first.ctl.connect();first.emit(full(base));first.ctl.dispose();
    const next=harness(root,validate);next.ctl.connect();await tick();assert.equal(next.starts[0].cursor,undefined);
    next.emit(full([fact(1,'session.created',{id:'saved'}),fact(2,'turn.input_committed',{message:'Replacement history'})],2));
    assert.deepEqual(next.ctl.store.userPrompts(),['Replacement history']);assert.equal(next.ctl.store.view().totals.total,0);next.ctl.dispose();
  }
});

test('tail and interrupted full replay never replace the last complete disk checkpoint',async t=>{
  const root=temporary(t),first=harness(root);first.ctl.connect();first.emit(full(base));first.ctl.dispose();
  const file=checkpoint(root),before=fs.readFileSync(file,'utf8');
  const next=harness(root);next.ctl.connect();await tick();
  next.emit({...full([fact(40,'turn.input_committed',{message:'Provisional tail'})],40),replay_tail:true,replay_chunk_final:true});
  assert.equal(next.ctl.store.replayComplete,false);
  next.emit({...full([fact(1,'turn.input_committed',{message:'Incomplete replacement'})],1),replay_chunk_final:false});
  next.ctl.dispose();assert.equal(fs.readFileSync(file,'utf8'),before);
  const recovered=harness(root);assert.deepEqual(recovered.ctl.store.userPrompts(),['Original prompt']);recovered.ctl.dispose();
});

test('cache files are private, atomic, session-bound and ignored when corrupt or from a different schema',t=>{
  const root=temporary(t),logs=[],cache=new SessionCache(root,'saved',m=>logs.push(m)),store=new SessionStore();
  const {normalizeRpcFrame}=require('../out/protocol.js');store.applyFrame(normalizeRpcFrame(full(base)));
  const state=store.snapshotProjection();cache.save(5,{sequence:5,eventId:'event-5'},state);
  const file=checkpoint(root);assert.equal(fs.statSync(file).mode&0o777,0o600);assert.equal(fs.statSync(path.dirname(file)).mode&0o777,0o700);
  assert.equal(cache.load().projection.parts[0].text,'Original prompt');
  const raw=fs.readFileSync(file,'utf8');fs.writeFileSync(file,'{broken');assert.equal(cache.load(),undefined);
  fs.writeFileSync(file,JSON.stringify({...JSON.parse(raw),version:99}));assert.equal(cache.load(),undefined);
  fs.writeFileSync(file,JSON.stringify({...JSON.parse(raw),sessionId:'other'}));assert.equal(cache.load(),undefined);
  assert.equal(new SessionCache(root,'different',()=>{}).load(),undefined);assert.equal(logs.length,3);
  cache.remove();assert.equal(fs.existsSync(file),false);
});

test('corrupt projection content is rejected before any cached reducer state can leak into full replay',t=>{
  const root=temporary(t),first=harness(root);first.ctl.connect();first.emit(full(base));first.ctl.dispose();
  const file=checkpoint(root),saved=JSON.parse(fs.readFileSync(file,'utf8'));saved.projection.parts=[{kind:'tool',turnNumber:1,call:null}];
  fs.writeFileSync(file,JSON.stringify(saved));const next=harness(root);t.after(()=>next.ctl.dispose());
  assert.equal(next.ctl.store.view().cached,false);assert.deepEqual(next.ctl.store.view().parts,[]);assert.match(next.logs.join('\n'),/projection ignored/);
});

test('disposing during witness validation neither starts a connection nor overwrites the complete checkpoint',async t=>{
  const root=temporary(t),first=harness(root);first.ctl.connect();first.emit(full(base));first.ctl.dispose();
  const file=checkpoint(root),before=fs.readFileSync(file,'utf8');let resolve;const wait=new Promise(done=>resolve=done),next=harness(root,()=>wait);
  next.ctl.connect();next.ctl.dispose();resolve('event-5');await tick();assert.deepEqual(next.starts,[]);assert.equal(fs.readFileSync(file,'utf8'),before);
});

test('a positive resume cursor cannot trail its reduced fact watermark',t=>{
  const root=temporary(t),first=harness(root);first.ctl.connect();first.emit(full(base));first.ctl.dispose();
  const file=checkpoint(root),saved=JSON.parse(fs.readFileSync(file,'utf8'));saved.projection.lastSequence=1000000;
  fs.writeFileSync(file,JSON.stringify(saved));const next=harness(root);t.after(()=>next.ctl.dispose());
  assert.equal(next.ctl.store.view().cached,false,'an inconsistent cursor could silently discard authoritative catch-up');assert.deepEqual(next.ctl.store.view().parts,[]);
});

test('cached state cannot authorize checkpoint, fork, prompt or turn controls through direct controller entry points',async t=>{
  const root=temporary(t),first=harness(root);first.ctl.connect();first.emit(full(base));first.ctl.dispose();
  const next=harness(root);t.after(()=>next.ctl.dispose());const commands=[];next.ctl.rpc.sendCommand=command=>{commands.push(command);return undefined;};
  for(const invoke of [()=>next.ctl.navigateCheckpoint({direction:'undo',restoreFiles:true}),()=>next.ctl.assertCheckpointTurn('turn'),()=>next.ctl.queuePrompt('Later'),()=>next.ctl.steer('turn','Now'),()=>next.ctl.cancelActive(),()=>next.ctl.withdraw('pending'),()=>next.ctl.interruptExec(1)])assert.throws(invoke,/synchroniz/i);
  assert.deepEqual(commands,[]);
});

test('ignored RPC frames do not rebuild or rewrite a clean session checkpoint',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const root=temporary(t),saved=harness(root);t.after(()=>saved.ctl.dispose());saved.ctl.connect();saved.emit(full(base));await tick();
  let projections=0,writes=0;
  const snapshot=saved.ctl.store.snapshotProjection.bind(saved.ctl.store),save=saved.ctl.cache.save.bind(saved.ctl.cache);
  saved.ctl.store.snapshotProjection=()=>{projections++;return snapshot();};
  saved.ctl.cache.save=(...args)=>{writes++;return save(...args);};
  t.mock.timers.tick(750);assert.equal(projections,1);assert.equal(writes,1);
  projections=0;writes=0;
  for(let i=0;i<10;i++){
    saved.emit({type:'organism.cells',names:['synthetic-'+i]});
    saved.emit({type:'gateway_turn_command_result',result:{command:'test',command_id:'test-'+i,status:'accepted'}});
    t.mock.timers.tick(750);
  }
  assert.equal(projections,0,'frames that mutate no cached store state must not traverse the full history');
  assert.equal(writes,0,'a clean checkpoint is not serialized and atomically replaced again');
  saved.ctl.dispose();assert.equal(projections,0,'disposal does not reconstruct a checkpoint already saved unchanged');
});

test('controllers without local checkpoint storage never build cache projections',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const saved=harness(undefined);t.after(()=>saved.ctl.dispose());saved.ctl.connect();saved.emit(full(base));await tick();
  let projections=0;const snapshot=saved.ctl.store.snapshotProjection.bind(saved.ctl.store);
  saved.ctl.store.snapshotProjection=()=>{projections++;return snapshot();};
  for(let i=0;i<5;i++){
    saved.emit({type:'item_delta',delta:{type:'text',text:'chunk '+i}});
    t.mock.timers.tick(750);
  }
  saved.ctl.dispose();assert.equal(projections,0,'disabled cache storage must not traverse retained process and transcript state');
});

test('same-cursor live changes and header, queue, process and family updates still refresh the checkpoint',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const root=temporary(t),saved=harness(root);t.after(()=>saved.ctl.dispose());saved.ctl.connect();saved.emit(full(base));await tick();
  let writes=0;const save=saved.ctl.cache.save.bind(saved.ctl.cache);saved.ctl.cache.save=(...args)=>{writes++;return save(...args);};
  t.mock.timers.tick(750);assert.equal(writes,1);const file=checkpoint(root);
  const read=()=>JSON.parse(fs.readFileSync(file,'utf8'));
  saved.emit({type:'item_delta',delta:{type:'text',text:'Uncommitted text'}});
  saved.emit({type:'item_delta',delta:{type:'reasoning',text:'Uncommitted thought'}});
  t.mock.timers.tick(750);assert.equal(writes,2);assert.equal(read().cursor,5);
  assert(read().projection.parts.some(part=>part.kind==='assistant'&&part.text==='Uncommitted text'&&part.reasoning==='Uncommitted thought'));
  saved.ctl.store.applyHeader({session_id:'saved',title:'Updated title',context_usage:{input:500}});
  saved.emit({type:'session_input_queue_snapshot_updated',session_id:'saved',snapshot:{version:1,pending_prompts:[{prompt_id:'pending',text:'queued'}]}});
  saved.emit({type:'session_background_process_updated',session_id:'saved',process:{shell_session_id:42,status:'running',command:'synthetic task',output:'output'}});
  saved.ctl.store.setThreads([{id:'saved',title:'Saved'},{id:'agent',parent_id:'saved',source:'fork',title:'Renamed agent'}],'saved');
  t.mock.timers.tick(750);assert.equal(writes,3);
  const state=read().projection;assert.equal(state.title,'Updated title');assert.equal(state.contextUsage.input,500);
  assert.equal(state.queueSnapshot.pending_prompts[0].prompt_id,'pending');assert(state.processes.some(row=>row.view.id==='42'));
  assert.equal(state.threadRows.find(row=>row.id==='agent').title,'Renamed agent');
  saved.emit({type:'session_stream_event',session_id:'saved',seq:9,event:{type:'session.future_fact',payload:{},metadata:{event_id:'event-9'}}});
  t.mock.timers.tick(750);assert.equal(writes,4,'an unrendered durable fact still advances the resumable checkpoint');
  assert.equal(read().cursor,9);assert.deepEqual(read().witness,{sequence:9,eventId:'event-9'});
  saved.emit({type:'item_delta',delta:{type:'text',text:' pending at close'}});
  saved.ctl.dispose();assert.equal(writes,5,'disposal flushes unsaved same-cursor content');
  assert(read().projection.parts.some(part=>part.kind==='assistant'&&part.text==='Uncommitted text pending at close'));
});

test('a failed checkpoint remains dirty and retries on later traffic or disposal',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const root=temporary(t),saved=harness(root);t.after(()=>saved.ctl.dispose());saved.ctl.connect();saved.emit(full(base));await tick();
  const save=saved.ctl.cache.save.bind(saved.ctl.cache);let attempts=0;
  saved.ctl.cache.save=(...args)=>{attempts++;return attempts===1?false:save(...args);};
  t.mock.timers.tick(750);assert.equal(attempts,1);assert.equal(fs.existsSync(path.join(root,'session-cache')),false);
  saved.emit({type:'organism.cells',names:[]});t.mock.timers.tick(750);
  assert.equal(attempts,2,'unsaved state retries when later traffic arrives, even if the frame changes no projection state');
  assert.equal(JSON.parse(fs.readFileSync(checkpoint(root),'utf8')).cursor,5);
  saved.emit({type:'item_delta',delta:{type:'text',text:'Retry at close'}});
  saved.ctl.cache.save=()=>{attempts++;return false;};t.mock.timers.tick(750);assert.equal(attempts,3);
  saved.ctl.cache.save=(...args)=>{attempts++;return save(...args);};saved.ctl.dispose();assert.equal(attempts,4);
  assert(JSON.parse(fs.readFileSync(checkpoint(root),'utf8')).projection.parts.some(part=>part.kind==='assistant'&&part.text==='Retry at close'));
});

test('continuous same-cursor updates save on a fixed deadline and completed replacement replay saves afresh',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const root=temporary(t),saved=harness(root);t.after(()=>saved.ctl.dispose());saved.ctl.connect();saved.emit(full(base));await tick();
  let writes=0;const save=saved.ctl.cache.save.bind(saved.ctl.cache);saved.ctl.cache.save=(...args)=>{writes++;return save(...args);};
  t.mock.timers.tick(750);assert.equal(writes,1);
  for(let i=0;i<7;i++){saved.emit({type:'item_delta',delta:{type:'text',text:'x'}});t.mock.timers.tick(100);}
  assert.equal(writes,1);t.mock.timers.tick(50);assert.equal(writes,2,'continuous updates cannot postpone the existing save deadline');
  const before=fs.readFileSync(checkpoint(root),'utf8');
  saved.emit({...full([fact(1,'session.created',{id:'saved'}),fact(2,'turn.input_committed',{message:'replacement'})],2),replay_chunk_final:false});
  t.mock.timers.tick(1500);assert.equal(writes,2);assert.equal(fs.readFileSync(checkpoint(root),'utf8'),before);
  saved.emit({type:'session_stream_resumed',session_id:'saved',admission_state:'ready',replay_chunk_index:1,replay_chunk_final:true,cursor:2,accumulated_frames:[]});
  t.mock.timers.tick(750);assert.equal(writes,3);
  const replaced=JSON.parse(fs.readFileSync(checkpoint(root),'utf8'));assert.equal(replaced.cursor,2);
  assert.deepEqual(replaced.witness,{sequence:2,eventId:'event-2'});assert.equal(replaced.projection.parts[0].text,'replacement');
});

test('an atomic cache write failure reports failure and leaves the completed checkpoint intact',t=>{
  const root=temporary(t),logs=[],cache=new SessionCache(root,'saved',message=>logs.push(message)),store=new SessionStore();
  const {normalizeRpcFrame}=require('../out/protocol.js');store.applyFrame(normalizeRpcFrame(full(base)));
  assert.equal(cache.enabled,true);assert.equal(new SessionCache(undefined,'saved',()=>{}).enabled,false);
  assert.equal(cache.save(5,{sequence:5,eventId:'event-5'},store.snapshotProjection()),true);
  const file=checkpoint(root),before=fs.readFileSync(file,'utf8');
  const rename=fs.renameSync;fs.renameSync=()=>{throw new Error('synthetic atomic replacement failure');};
  try{assert.equal(cache.save(5,{sequence:5,eventId:'event-5'},store.snapshotProjection()),false);}
  finally{fs.renameSync=rename;}
  assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(fs.readdirSync(path.dirname(file)).length,1);
  assert.match(logs.join('\n'),/synthetic atomic replacement failure/);
});

test('removing a checkpoint prevents pending saves and disposal from recreating it',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const root=temporary(t),saved=harness(root);t.after(()=>saved.ctl.dispose());saved.ctl.connect();saved.emit(full(base));await tick();
  t.mock.timers.tick(750);const file=checkpoint(root);assert.equal(fs.existsSync(file),true);
  saved.emit({type:'item_delta',delta:{type:'text',text:'pending'}});saved.ctl.removeCache();
  t.mock.timers.tick(750);saved.emit({type:'item_delta',delta:{type:'text',text:'more'}});t.mock.timers.tick(750);saved.ctl.dispose();
  assert.equal(fs.existsSync(file),false);
});

test('a witness-only upgrade is persisted when a duplicate durable fact leaves the store unchanged',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const root=temporary(t),saved=harness(root);t.after(()=>saved.ctl.dispose());saved.ctl.connect();
  saved.emit(full(base.map(frame=>({...frame,event:{...frame.event,metadata:undefined}}))));await tick();
  let writes=0;const save=saved.ctl.cache.save.bind(saved.ctl.cache);saved.ctl.cache.save=(...args)=>{writes++;return save(...args);};
  t.mock.timers.tick(750);assert.equal(writes,1);const file=checkpoint(root);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).witness,undefined);
  saved.emit({type:'session_stream_event',...fact(5,'turn.completed')});t.mock.timers.tick(750);
  assert.equal(writes,2);assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')).witness,{sequence:5,eventId:'event-5'});
  saved.emit({type:'session_stream_event',...fact(5,'turn.completed')});t.mock.timers.tick(750);
  assert.equal(writes,2,'an identical witness is not another checkpoint change');
});
