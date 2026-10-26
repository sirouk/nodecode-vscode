import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {CheckpointBookmarks}=require('../out/checkpoint-bookmarks.js');
const {SessionStore}=require('../out/store.js');
test('checkpoint bookmarks persist by session and serialize rapid toggles without native writes',async()=>{
 const values=new Map(),state={get:(key,fallback)=>values.get(key)??fallback,update:async(key,value)=>{await Promise.resolve();values.set(key,value);}};
 const bookmarks=new CheckpointBookmarks(state);
 await Promise.all([bookmarks.toggle('one','turn-a'),bookmarks.toggle('one','turn-b')]);
 assert.deepEqual(new CheckpointBookmarks(state).list('one'),['turn-a','turn-b']);
 assert.deepEqual(bookmarks.list('two'),[]);
 await Promise.all([bookmarks.toggle('one','turn-a'),bookmarks.toggle('one','turn-a')]);
 assert.deepEqual(bookmarks.list('one'),['turn-b','turn-a']);
 await Promise.all([bookmarks.save('one','turn-a'),bookmarks.save('one','turn-c')]);
 assert.deepEqual(bookmarks.list('one'),['turn-b','turn-a','turn-c']);
});
test('standby save status follows own native identity, never inherited replay or command acknowledgement',()=>{
 const store=new SessionStore();store.setCheckpointBookmarks(['turn-a']);
 store.setSessionDetail({session_id:'child',cwd:'/tmp',standby:true});
 store.applyFrame({type:'session_stream_resumed',session_id:'child',accumulated_frames:[{type:'session_stream_event',session_id:'parent',sequence:1,event:{type:'session.created',payload:{id:'parent'}}}]});
 assert.equal(store.view().standby,true);assert.deepEqual(store.view().bookmarkedTurnIds,['turn-a']);
 store.applyFrame({type:'gateway_turn_command_result',result:{status:'accepted',command:'start_turn'}});
 assert.equal(store.view().standby,true);
 store.applyFrame({type:'session_stream_event',session_id:'child',sequence:2,event:{type:'session.created',payload:{id:'child'}}});
 assert.equal(store.view().standby,false);
 store.setSessionDetail({session_id:'child',cwd:'/tmp',standby:true});
 assert.equal(store.view().standby,false);
});
test('fork saves checkpoint first and preserves correct failure boundaries',async()=>{
 const values=new Map();let writes=0,forks=0,invalid=false,writeFails=false,forkFails=false;
 const bookmarks=new CheckpointBookmarks({get:(key,fallback)=>values.get(key)??fallback,update:async(key,value)=>{writes++;if(writeFails)throw Error('write failed');values.set(key,value);}});
 const controller={sessionId:'parent',assertCheckpointTurn(){if(invalid)throw Error('invalid turn');},store:{setCheckpointBookmarks(){}},async forkAtMessage(){forks++;assert.deepEqual(bookmarks.list('parent'),['turn']);if(forkFails)throw Error('fork failed');return 'child';}};
 invalid=true;await assert.rejects(bookmarks.fork(controller,'turn'),/invalid/);assert.equal(writes,0);assert.equal(forks,0);
 invalid=false;writeFails=true;await assert.rejects(bookmarks.fork(controller,'turn'),/write failed/);assert.equal(forks,0);assert.deepEqual(bookmarks.list('parent'),[]);
 writeFails=false;forkFails=true;await assert.rejects(bookmarks.fork(controller,'turn'),/fork failed/);assert.deepEqual(bookmarks.list('parent'),['turn']);
 forkFails=false;assert.equal(await bookmarks.fork(controller,'turn'),'child');assert.deepEqual(bookmarks.list('parent'),['turn']);
});
