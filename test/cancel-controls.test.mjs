import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {SessionController}=require('../out/manager.js');

test('the stop control resolves the confirmed live turn and never sends a missing or stale target',()=>{
  const controller=new SessionController({},{log(){}},{},'/workspace','cancel-boundary');
  const commands=[];
  controller.rpc.sendCommand=command=>{commands.push(command);return {done:Promise.resolve({status:'accepted'})};};
  try{
    assert.throws(()=>controller.cancelActive(),/synchroniz/);
    controller.store.applyFrame({type:'session_stream_resumed',session_id:'cancel-boundary',cursor:1,replay_chunk_final:true,accumulated_frames:[
      {type:'session_stream_event',session_id:'cancel-boundary',sequence:1,turn_id:'live-turn',event:{type:'turn.started',payload:{}}},
    ]});
    controller.rpc.setState('connected');
    controller.cancelActive();
    controller.cancelActive(null);
    controller.cancelActive('live-turn');
    assert.deepEqual(commands,[
      {type:'cancel_turn',turn_id:'live-turn'},
      {type:'cancel_turn',turn_id:'live-turn'},
      {type:'cancel_turn',turn_id:'live-turn'},
    ]);
    controller.rpc.setState('disconnected');
    assert.throws(()=>controller.cancelActive('live-turn'),/synchroniz/);
    assert.equal(commands.length,3,'retained turn ids cannot authorize a disconnected cancellation');
    controller.rpc.setState('connected');
    controller.store.applyFrame({type:'session_stream_event',session_id:'cancel-boundary',sequence:2,turn_id:'live-turn',event:{type:'turn.cancelled',payload:{}}});
    assert.throws(()=>controller.cancelActive(),/no active turn/);
    assert.equal(commands.length,3,'an ended turn cannot be cancelled again');
  }finally{controller.dispose();}
});
