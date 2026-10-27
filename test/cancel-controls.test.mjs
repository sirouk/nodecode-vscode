import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {SessionController}=require('../out/manager.js');

test('the controller never sends a missing or unconfirmed cancellation target',()=>{
  const controller=new SessionController({},{log(){}},{},'/workspace','cancel-boundary');
  const commands=[];
  controller.rpc.sendCommand=command=>{commands.push(command);return {done:Promise.resolve({status:'accepted'})};};
  try{
    assert.throws(()=>controller.cancelActive('old-turn'),/synchroniz/);
    controller.store.applyFrame({type:'session_stream_resumed',session_id:'cancel-boundary',cursor:1,replay_chunk_final:true,accumulated_frames:[
      {type:'session_stream_event',session_id:'cancel-boundary',sequence:1,turn_id:'live-turn',event:{type:'turn.started',payload:{}}},
    ]});
    controller.rpc.setState('connected');
    assert.throws(()=>controller.cancelActive(),/no active turn/);
    assert.throws(()=>controller.cancelActive(null),/no active turn/);
    assert.deepEqual(commands,[]);
    controller.cancelActive('live-turn');
    assert.deepEqual(commands,[{type:'cancel_turn',turn_id:'live-turn'}]);
    controller.rpc.setState('disconnected');
    assert.throws(()=>controller.cancelActive('live-turn'),/synchroniz/);
    assert.equal(commands.length,1,'retained turn ids cannot authorize a disconnected cancellation');
  }finally{controller.dispose();}
});
