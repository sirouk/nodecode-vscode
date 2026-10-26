import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {SessionController}=require('../out/manager.js');
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const usage=(sequence,input,output)=>({type:'session_stream_event',session_id:'branch',sequence,event:{type:'turn.usage',payload:{'input-tokens':input,'output-tokens':output}}});

test('replacement replay invalidates old-branch header and detail requests before its scheduled refresh',async()=>{
  const oldHeader=deferred(),oldDetail=deferred(),refreshed=deferred();let requests=0;
  const api={
    header:()=>++requests===1?oldHeader.promise:Promise.resolve({through:10,session_usage:{input:100,output:10},context_usage:{input:100}}),
    sessionDetail:()=>requests===0?oldDetail.promise:Promise.resolve({session_id:'branch',cwd:'/selected-branch',standby:false}),
  };
  const ctl=new SessionController({},{log(){}},api,'/workspace','branch');
  try{
    ctl.store.setThreads([],'branch');
    ctl.store.applyFrame(usage(20,200,20));
    ctl.refreshHeader();
    ctl.rpc.onFrame({type:'session_stream_resumed',session_id:'branch',replay_chunk_final:true,accumulated_frames:[usage(10,100,10)]});
    oldDetail.resolve({session_id:'branch',cwd:'/old-branch',standby:false});
    oldHeader.resolve({through:20,session_usage:{input:200,output:20},context_usage:{input:200}});
    await new Promise(setImmediate);
    assert.equal(ctl.store.view().totals.input,100,'pre-replay HTTP result must not poison the replacement branch');
    assert.notEqual(ctl.store.view().cwd,'/old-branch');
    const refresh=ctl.refreshHeader.bind(ctl);ctl.refreshHeader=()=>{refresh();refreshed.resolve();};
    await refreshed.promise;await new Promise(setImmediate);
    assert.equal(requests,2);assert.equal(ctl.store.view().totals.input,100);assert.equal(ctl.store.view().totals.output,10);
    assert.equal(ctl.store.view().cwd,'/selected-branch');
  }finally{ctl.dispose();}
});

test('ordinary sends steer the current active turn; queueing is explicit and one-shot',()=>{
  const ctl=new SessionController({},{log(){}},{},'/workspace','steering');
  const commands=[];ctl.rpc.sendCommand=command=>{commands.push(command);return {done:Promise.resolve({status:'accepted'})};};
  try{
    ctl.store.applyFrame({type:'session_stream_event',session_id:'steering',sequence:1,turn_id:'working-turn',event:{type:'turn.started',payload:{}}});
    ctl.sendPrompt('Correct the current approach');
    assert.deepEqual(commands.at(-1),{type:'steer_turn',expected_turn_id:'working-turn',prompt:'Correct the current approach'});
    ctl.queuePrompt('Do this after the current response');
    assert.deepEqual(commands.at(-1),{type:'start_turn',prompt:'Do this after the current response'});
    ctl.sendPrompt('Another immediate correction');
    assert.equal(commands.at(-1).type,'steer_turn','queueing one message must not change the next send');
    ctl.store.applyFrame({type:'session_stream_event',session_id:'steering',sequence:2,turn_id:'working-turn',event:{type:'turn.completed',payload:{}}});
    ctl.sendPrompt('Begin new work');
    assert.deepEqual(commands.at(-1),{type:'start_turn',prompt:'Begin new work'});
  }finally{ctl.dispose();}
});

test('an active turn without a steering target never silently queues an ordinary send',()=>{
  const ctl=new SessionController({},{log(){}},{},'/workspace','unavailable');
  const commands=[];ctl.rpc.sendCommand=command=>{commands.push(command);return {done:Promise.resolve({status:'accepted'})};};
  try{
    ctl.store.applyFrame({type:'session_stream_event',session_id:'unavailable',sequence:1,turn_id:'working-turn',event:{type:'turn.started',payload:{}}});
    ctl.store.applyFrame({type:'session_input_queue_snapshot_updated',session_id:'unavailable',snapshot:{active_turn:'working-turn',active_turn_steerable:false,pending_prompts:[]}});
    assert.throws(()=>ctl.sendPrompt('Steer now'),/not.*steer|cannot.*steer/i);
    assert.equal(commands.length,0);
    ctl.queuePrompt('Explicit follow-up');assert.equal(commands.at(-1).type,'start_turn');
  }finally{ctl.dispose();}
});

test('automatic steering preserves native image content instead of sending a queued text-only prompt',()=>{
  const ctl=new SessionController({},{log(){}},{},'/workspace','image-steering');let command;
  ctl.rpc.sendCommand=value=>{command=value;return {done:Promise.resolve({status:'accepted'})};};
  const image={mediaType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZcToAAAAASUVORK5CYII='};
  try{
    ctl.store.applyFrame({type:'session_stream_event',session_id:'image-steering',sequence:1,turn_id:'image-turn',event:{type:'turn.started',payload:{}}});
    ctl.sendPrompt('',[image]);
    assert.equal(command.type,'steer_turn');assert.equal(command.expected_turn_id,'image-turn');
    assert.equal(command.content[1].source.data,image.data);
  }finally{ctl.dispose();}
});
