import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SessionStore, messageText, messageReasoning } = require('../out/store.js');
const event = (sequence, type, payload = {}) => ({ type: 'session_stream_event', sequence, event: { type, payload } });

test('message forks use recorded native turn identities and reject unknown or active turns', async () => {
  const {SessionController} = require('../out/manager.js');
  const calls=[];
  const controller=new SessionController({}, {log(){}}, {forkSession:async(...args)=>{calls.push(args);return 'new-child';}}, '/workspace', 'parent');
  const apply=(sequence,type,turn_id,payload={})=>controller.store.applyFrame({...event(sequence,type,payload),turn_id});
  try {
    apply(1,'turn.started','turn-one');
    apply(2,'turn.input_committed','turn-one',{message:'First question'});
    apply(3,'turn.assistant_message_completed','turn-one',{message:{content:'First answer'}});
    await assert.rejects(controller.forkAtMessage('turn-one'),/recorded assistant/);
    apply(4,'turn.completed','turn-one');
    apply(5,'turn.started','turn-two');
    apply(6,'turn.assistant_message_completed','turn-two',{message:{content:'Second answer'}});
    apply(7,'turn.completed','turn-two');
    const parts=controller.store.view().parts;
    assert.deepEqual(parts.filter(p=>p.kind==='assistant').map(p=>p.forkTurnId),['turn-one','turn-two']);
    assert.equal(parts.find(p=>p.kind==='user').forkTurnId,undefined);
    assert.equal(await controller.forkAtMessage('turn-one'),'new-child');
    assert.deepEqual(calls,[['parent','turn-one']]);
    assert.deepEqual(controller.store.view().parts,parts);
    await assert.rejects(controller.forkAtMessage('invented'),/recorded assistant/);
  } finally {controller.dispose();}
});

test('durable reasoning is separate from the visible answer', () => {
  const message = { role: 'assistant', content: 'The answer', reasoning_content: 'Considered the options' };
  assert.equal(messageText(message), 'The answer');
  assert.equal(messageReasoning(message), 'Considered the options');
  const blocks = { content: [{ type: 'thinking', thinking: 'Private analysis' }, { type: 'text', text: 'Result' }] };
  assert.equal(messageText(blocks), 'Result');
  assert.equal(messageReasoning(blocks), 'Private analysis');
});

test('live reasoning is retained when the completed answer lands', () => {
  const store = new SessionStore();
  store.applyFrame(event(1, 'turn.started'));
  store.applyFrame({ type: 'item_delta', delta: { type: 'reasoning', text: 'Working through it' } });
  store.applyFrame({ type: 'item_delta', delta: { type: 'text', text: 'Partial' } });
  store.applyFrame(event(2, 'turn.assistant_message_completed', { message: { content: 'Complete answer', reasoning_content: 'Working through it' } }));
  store.applyFrame(event(3, 'turn.completed'));
  const assistant = store.view().parts.filter(p => p.kind === 'assistant');
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0].text, 'Complete answer');
  assert.equal(assistant[0].reasoning, 'Working through it');
  assert.equal(assistant[0].streaming, false);
});

test('replay is idempotent and clears stale transient state', () => {
  const store = new SessionStore();
  const frames = [event(1, 'session.created', { id: 'parent', cwd: '/workspace' }), event(2, 'turn.started'), event(3, 'turn.assistant_message_completed', { message: { content: 'Done', reasoning_content: 'Reasoned' } }), event(4, 'turn.usage', { 'input-tokens': 100, 'output-tokens': 20, 'total-tokens': 120, cost_known: true, cost_usd: 0.25 }), event(5, 'turn.completed')];
  store.applyFrames(frames);
  const before = store.view();
  store.applyFrame({ type: 'session_input_queue_snapshot_updated', snapshot: { active_turn: 'stale', pending_prompts: [{ prompt_id: 'stale' }] } });
  store.applyFrame({ type: 'session_background_process_updated', process: { exec_id: 'stale', command: 'sleep', status: 'running' } });
  store.applyFrame({ type: 'session_stream_resumed', session_id: 'parent', accumulated_frames: frames });
  const after = store.view();
  assert.deepEqual(after.parts, before.parts);
  assert.deepEqual(after.totals, before.totals);
  assert.equal(after.running, false);
  assert.deepEqual(after.queue, []);
  assert.deepEqual(after.processes, []);
  store.applyFrames(frames);
  assert.deepEqual(store.view().parts, before.parts);
  assert.deepEqual(store.view().totals, before.totals);
});

test('tool results complete the matching tool without duplicating it', () => {
  const store = new SessionStore();
  store.applyFrames([event(1, 'turn.started'), event(2, 'turn.tool_call_started', { 'call-id': 'tool1', 'tool-name': 'shell', arguments: '{"command":"pwd"}' }), event(3, 'turn.tool_result', { 'call-id': 'tool1', result: '/workspace', 'duration-ms': 12 })]);
  const tools = store.view().parts.filter(p => p.kind === 'tool');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].call.done, true);
  assert.equal(tools[0].call.result, '/workspace');
});

test('thread roster scopes children to the current parent', () => {
  const store = new SessionStore();
  store.setThreads([
    { id: 'parent', title: 'Parent' },
    { id: 'child', title: 'Research', parent_id: 'parent', depth: 1, relation: 'thread' },
    { id: 'unrelated', title: 'Other', parent_id: 'elsewhere' }
  ], 'parent');
  assert.deepEqual(store.view().threads.map(t => t.id), ['child']);
});

test('stream retry clears both discarded answer and reasoning', () => {
  const store = new SessionStore();
  store.applyFrame({ type: 'item_delta', delta: { type: 'reasoning', text: 'Discard this' } });
  store.applyFrame({ type: 'item_delta', delta: { type: 'text', text: 'Partial answer' } });
  store.applyFrame({ type: 'item_delta', delta: { type: 'stream_reset' } });
  const last = store.view().parts.at(-1);
  assert.equal(last.text, '');
  assert.equal(last.reasoning, '');
});

test('activity snapshots replace running thread state', () => {
  const store = new SessionStore();
  store.setThreads([{ id: 'child', parent_id: 'parent', title: 'Child', relation: 'detached' }], 'parent');
  store.applyFrame({ type: 'organism.activity', sessions: [{ id: 'child', status: 'running' }] });
  assert.equal(store.view().threads[0].status, 'running');
  store.applyFrame({ type: 'organism.activity', sessions: [] });
  assert.equal(store.view().threads[0].status, 'idle');
});

test('real sync envelopes normalize live and chunked replay facts', () => {
  const { normalizeRpcFrame } = require('../out/protocol.js');
  const store = new SessionStore();
  const fact = (seq, type, payload) => ({ seq, session_id: 'parent', event: { type, payload } });
  const initial = normalizeRpcFrame({ sequence: 5, payload: { type: 'session_stream_resumed', session_id: 'parent', replay_chunk_index: 0, replay_chunk_final: false, accumulated_frames: [fact(1, 'turn.started', {}), fact(2, 'turn.assistant_message_completed', { message: { content: 'First', reasoning_content: 'Thinking' } })] } });
  assert.equal(initial.type, 'session_stream_resumed');
  assert.equal(initial.accumulated_frames[1].sequence, 2);
  store.applyFrame(initial);
  store.applyFrame(normalizeRpcFrame({ sequence: 6, payload: { type: 'session_stream_resumed', session_id: 'parent', replay_chunk_index: 1, replay_chunk_final: true, accumulated_frames: [fact(3, 'turn.completed', {})] } }));
  assert.equal(store.view().parts.length, 1);
  assert.equal(store.view().parts[0].reasoning, 'Thinking');
  store.applyFrame(normalizeRpcFrame({ sequence: 7, payload: { type: 'session_stream_event', frame: fact(4, 'turn.input_committed', { message: { content: 'Next' } }) } }));
  assert.equal(store.view().parts.at(-1).text, 'Next');
  // Standalone frame compatibility remains supported for existing clients.
  assert.equal(normalizeRpcFrame(event(5, 'turn.completed')).type, 'session_stream_event');
});

test('multiple panels receive store updates until each unsubscribes', () => {
  const store = new SessionStore();
  let editor = 0, sidebar = 0;
  const first = store.subscribe(() => editor++);
  const second = store.subscribe(() => sidebar++);
  store.applyFrame({type:'session_titled',title:'One'});
  assert.equal(editor, 1); assert.equal(sidebar, 1);
  first.dispose();
  store.applyFrame({type:'session_titled',title:'Two'});
  assert.equal(editor, 1); assert.equal(sidebar, 2);
  second.dispose();
});

test('durable image-only messages survive replay', () => {
  const store = new SessionStore();
  store.applyFrames([
    event(1, 'turn.input_committed', {role:'user', message:{content:[]}, metadata:{images:[{id:'image-1',media_type:'image/png'}]}}),
    event(2, 'turn.assistant_message_completed', {message:{content:[]}, metadata:{images:[{id:'image-2',media_type:'image/jpeg'}]}})
  ]);
  assert.equal(store.view().parts.length, 2);
  assert.deepEqual(store.view().parts[0].images, [{id:'image-1',mediaType:'image/png'}]);
  assert.deepEqual(store.view().parts[1].images, [{id:'image-2',mediaType:'image/jpeg'}]);
});

test('native string user messages survive initial replay and live follow-ups in order', () => {
  const { normalizeRpcFrame } = require('../out/protocol.js');
  const fact = (seq, type, payload) => ({seq, session_id:'native', event:{type,payload}});
  const store = new SessionStore();
  store.applyFrame(normalizeRpcFrame({sequence:1,payload:{type:'session_stream_resumed',session_id:'native',replay_chunk_final:true,accumulated_frames:[
    fact(27,'turn.input_committed',{role:'user',message:'Tell me a few jokes','prompt-id':'c1'}),
    fact(28,'turn.started',{input:'Tell me a few jokes'}),
    fact(35,'turn.assistant_message_completed',{role:'assistant',message:{role:'assistant',content:'Some jokes.'}}),
    fact(36,'turn.completed',{}),
  ]}}));
  const followup = normalizeRpcFrame({sequence:2,payload:{type:'session_stream_event',frame:fact(43,'turn.input_committed',{role:'user',message:'lol','prompt-id':'c2'})}});
  store.applyFrame(followup);
  store.applyFrame(followup);
  store.applyFrame(event(44,'turn.started',{input:'lol'}));
  store.applyFrame(event(47,'turn.assistant_message_completed',{role:'assistant',message:{role:'assistant',content:'The fridge and I are now in a cold war.'}}));
  assert.deepEqual(store.view().parts.map(p=>[p.kind,p.text]), [
    ['user','Tell me a few jokes'], ['assistant','Some jokes.'], ['user','lol'], ['assistant','The fridge and I are now in a cold war.'],
  ]);
  assert.deepEqual(store.userPrompts(), ['Tell me a few jokes','lol']);
});

test('native tool input streams hydrate once and retain display metadata and failure', () => {
  const store = new SessionStore();
  store.applyFrame(event(1,'turn.started'));
  store.applyFrame({type:'item_delta',delta:{type:'tool_call',index:0,name:'eval',arguments:'{"code":'}});
  store.applyFrame({type:'item_delta',delta:{type:'tool_call',index:0,name:'eval',arguments:'{"code":"(+ 1 2)"}'}});
  assert.equal(store.view().parts[0].call.arguments, '{"code":"(+ 1 2)"}');
  store.applyFrame(event(2,'turn.tool_call_started',{'call-id':'call1','tool-name':'eval',arguments:'{"code":"(+ 1 2)"}'}));
  const metadata={image:{path:'/workspace/chart.png',media_type:'image/png'},snippet:{note:'Plot chart'}};
  store.applyFrame(event(3,'turn.tool_result',{'call-id':'call1','tool-name':'eval',result:'{"error":"refused"}',failed:true,metadata,'duration-ms':12}));
  assert.equal(store.view().parts.length,1);
  assert.deepEqual(store.view().parts[0].call, {callId:'call1',name:'eval',arguments:'{"code":"(+ 1 2)"}',done:true,status:'failed',result:'{"error":"refused"}',failed:true,metadata,durationMs:12});
});

test('native queued input is rendered only on promotion', () => {
  const store = new SessionStore();
  store.applyFrame(event(1,'turn.input_committed',{role:'user',message:'later',disposition:'follow-up','prompt-id':'p1'}));
  assert.equal(store.view().parts.length,0);
  store.applyFrame(event(2,'turn.input_committed',{role:'user',message:'later',disposition:'started','prompt-id':'p1'}));
  assert.deepEqual(store.userPrompts(),['later']);
});

test('native voided attempts preserve paid output and continuation excludes sealed prefix', () => {
  const store = new SessionStore();
  store.applyFrame(event(1,'turn.started'));
  store.applyFrame({type:'item_delta',delta:{type:'reasoning',text:'old thought'}});
  store.applyFrame({type:'item_delta',delta:{type:'text',text:'old 😀'}});
  store.applyFrame(event(2,'turn.attempt_voided',{attempt:1,reasoning:'old thought',text:'old 😀',detail:'stream interrupted',disposition:'continued'}));
  store.applyFrame({type:'item_delta',delta:{type:'stream_reset'}});
  store.applyFrame({type:'item_delta',delta:{type:'text',text:'new'}});
  store.applyFrame(event(3,'turn.assistant_message_completed',{message:{content:'old 😀new',reasoning_content:'old thoughtnext'},'continued-content-chars':5,'continued-reasoning-chars':11}));
  const replies=store.view().parts.filter(p=>p.kind==='assistant');
  assert.equal(replies.length,2);
  assert.equal(replies[0].text,'old 😀');
  assert.match(replies[0].voided,/stream interrupted/);
  assert.equal(replies[1].text,'new');
  assert.equal(replies[1].reasoning,'next');
});

test('native retry, fallback, context and termination details remain visible', () => {
  const store = new SessionStore();
  store.applyFrames([
    event(1,'turn.started'),
    event(2,'turn.provider_retry',{provider:'local','delay-seconds':2,detail:'busy'}),
    event(3,'turn.provider_fallback',{'from-model':'a','to-model':'b',detail:'unavailable'}),
    event(4,'session.context.evicted',{'evicted-turn-count':2,'evicted-message-count':4,'retained-message-count':3}),
    event(5,'turn.usage',{'finish-reason':'length'}),
    event(6,'turn.completed'),
    event(7,'turn.started'),
    event(8,'turn.failed',{detail:'Actual provider failure'}),
  ]);
  const notices=store.view().parts.filter(p=>p.kind==='system').map(p=>p.text);
  assert(notices.some(t=>t.includes('busy')));
  assert(notices.some(t=>t.includes('a → b')));
  assert(notices.some(t=>t.includes('4 messages; 3 retained')));
  assert(notices.includes('Response ended: length'));
  assert(notices.includes('Actual provider failure'));
});

test('assistant round hydrates before interleaved streamed tool input without duplicate text',()=>{
  const store=new SessionStore();
  store.applyFrame(event(1,'turn.started'));
  store.applyFrame({type:'item_delta',delta:{type:'reasoning',text:'Plan'}});
  store.applyFrame({type:'item_delta',delta:{type:'text',text:'Reading now'}});
  store.applyFrame({type:'item_delta',delta:{type:'tool_call',index:0,name:'eval',arguments:'{"code":"read"}'}});
  store.applyFrame(event(2,'turn.assistant_message_completed',{message:{content:'Reading now',reasoning_content:'Plan'}}));
  store.applyFrame(event(3,'turn.tool_call_started',{'call-id':'actual','tool-name':'eval',arguments:'{"code":"read"}'}));
  assert.deepEqual(store.view().parts.map(p=>p.kind),['assistant','tool']);
  assert.equal(store.view().parts[0].text,'Reading now');
  assert.equal(store.view().parts[0].durable,true);
});

test('replay readiness waits for full final chunk rather than fast tail preview', () => {
  const store = new SessionStore();
  const replay = fields => ({type:'session_stream_resumed',session_id:'session',accumulated_frames:[],...fields});
  assert.equal(store.view().replayComplete,false);
  store.applyFrame(replay({replay_tail:true,replay_chunk_index:0,replay_chunk_final:true}));
  assert.equal(store.view().replayComplete,false);
  store.applyFrame(replay({replay_chunk_index:0,replay_chunk_final:false}));
  assert.equal(store.view().replayComplete,false);
  store.applyFrame(replay({replay_chunk_index:1,replay_chunk_final:true}));
  assert.equal(store.view().replayComplete,true);
  store.applyFrame(replay({replay_chunk_index:0,replay_chunk_final:false}));
  assert.equal(store.view().replayComplete,false);
  store.applyFrame(replay({replay_chunk_index:1,replay_chunk_final:true}));
  assert.equal(store.view().replayComplete,true);
});

test('cursor resume replaces stale partial overlay while preserving durable messages and sequence gaps',()=>{
  const store=new SessionStore();
  store.applyFrame({type:'session_stream_resumed',session_id:'s',cursor:10,replay_chunk_final:true,accumulated_frames:[
    event(1,'turn.input_committed',{message:'original',role:'user'}),event(10,'turn.started'),
  ]});
  store.applyFrame({type:'item_delta',delta:{type:'text',text:'partial'}});
  store.applyFrame({type:'item_delta',delta:{type:'tool_call',index:0,name:'eval',arguments:'{"code":'}});
  store.applyFrame({type:'session_stream_resumed',session_id:'s',resumed_after:10,cursor:22,replay_chunk_final:true,accumulated_frames:[]});
  store.applyFrame({type:'item_delta',delta:{type:'text',text:'partial'}});
  assert.deepEqual(store.view().parts.map(p=>[p.kind,p.text]),[['user','original'],['assistant','partial']]);
  store.applyFrame(event(22,'turn.assistant_message_completed',{message:{content:'complete'}}));
  store.applyFrame(event(22,'turn.assistant_message_completed',{message:{content:'duplicate'}}));
  assert.equal(store.view().parts.at(-1).text,'complete');
});

test('native omitted final flag does not finish an indexed history replay',()=>{
  const {normalizeRpcFrame}=require('../out/protocol.js');
  const store=new SessionStore();
  store.applyFrame(normalizeRpcFrame({sequence:1,payload:{type:'session_stream_resumed',session_id:'s',replay_chunk_index:0,admission_state:'ready',accumulated_frames:[{seq:1,event:{type:'turn.started',payload:{}}}]}}));
  assert.equal(store.view().replayComplete,false);
  assert.equal(store.view().running,true);
  store.applyFrame(normalizeRpcFrame({sequence:2,payload:{type:'session_stream_resumed',session_id:'s',replay_chunk_index:1,replay_chunk_final:true,admission_state:'ready',cursor:2,accumulated_frames:[]}}));
  assert.equal(store.view().replayComplete,true);
  assert.equal(store.view().running,false);
});


test('session totals sum rounds while context reflects only the newest round',()=>{
  const store=new SessionStore();
  const usage=(sequence,input,output,cached,total,cost)=>event(sequence,'turn.usage',{'input-tokens':input,'output-tokens':output,'cached-input-tokens':cached,'cache-write-tokens':10,'total-tokens':total,cost_known:true,cost_usd:cost});
  store.applyFrames([usage(1,1000,100,30,1130,0.1),usage(2,200,40,20,260,0.2)]);
  const before=store.view();
  assert.deepEqual({input:before.totals.input,output:before.totals.output,cached:before.totals.cached,total:before.totals.total},{input:1200,output:140,cached:50,total:1390});
  assert.deepEqual(before.contextUsage,{input:200,cached:20,cacheWrite:10});
  store.applyHeader({through:2,session_usage:{input:1200,output:140,cached:50,total:1390,cost:0.3,cost_known:true},context_usage:{input:200,cached:20,cache_write:10}});
  const after=store.view();
  assert.deepEqual(after.contextUsage,before.contextUsage);
  assert.deepEqual({...after.totals,costUsd:0},{...before.totals,costUsd:0});
});

test('a delayed header cannot roll newer usage and context backward',()=>{
  const store=new SessionStore();
  store.applyFrame(event(1,'turn.usage',{'input-tokens':1000,'output-tokens':10,'total-tokens':1010,cost_known:true,cost_usd:0.1}));
  store.applyFrame(event(2,'turn.usage',{'input-tokens':200,'output-tokens':20,'total-tokens':220,cost_known:true,cost_usd:0.2}));
  const before=store.view();
  store.applyHeader({through:1,session_usage:{input:1000,output:10,total:1010,cost:0.1,cost_known:true},context_usage:{input:1000}});
  assert.deepEqual(store.view().totals,before.totals);
  assert.deepEqual(store.view().contextUsage,before.contextUsage);
});

test('a header watermark prevents duplicate usage during replay without hiding transcript facts',()=>{
  const store=new SessionStore();
  store.applyHeader({through:4,session_usage:{input:300,output:40,cached:10,total:350,cost:0.3,cost_known:true},context_usage:{input:100,cached:5}});
  store.applyFrames([
    event(1,'turn.started'),
    event(2,'turn.assistant_message_completed',{message:{content:'First answer'}}),
    event(3,'turn.usage',{'input-tokens':200,'output-tokens':20,'cached-input-tokens':5,'total-tokens':225,cost_known:true,cost_usd:0.1}),
    event(4,'turn.usage',{'input-tokens':100,'output-tokens':20,'cached-input-tokens':5,'total-tokens':125,cost_known:true,cost_usd:0.2}),
  ]);
  assert.equal(store.view().totals.output,40);
  assert.equal(store.view().totals.input,300);
  assert.equal(store.view().totals.costUsd,0.3);
  assert.equal(store.view().parts.find(p=>p.kind==='assistant').text,'First answer');
  assert.deepEqual(store.view().contextUsage,{input:100,cached:5,cacheWrite:0});
  store.applyFrame({type:'session_stream_resumed',session_id:'own',resumed_after:4,replay_chunk_final:true,accumulated_frames:[event(4,'turn.usage',{'output-tokens':20})]});
  assert.equal(store.view().totals.output,40);
  store.applyFrame(event(5,'turn.usage',{'input-tokens':50,'output-tokens':5,'total-tokens':55,cost_known:true,cost_usd:0.05}));
  assert.equal(store.view().totals.output,45);
  assert.equal(store.view().totals.input,350);
  assert.deepEqual(store.view().contextUsage,{input:50,cached:0,cacheWrite:0});
});

test('native inherited replay wrappers do not make ancestor facts belong to a standby child',()=>{
  const store=new SessionStore();
  const fact=(sequence,type,payload={})=>({...event(sequence,type,payload),session_id:'child'});
  store.setThreads([],'child');
  store.setSessionDetail({session_id:'child',cwd:'/child',standby:true});
  store.applyFrame({type:'session_stream_resumed',session_id:'child',replay_chunk_index:0,replay_chunk_final:false,accumulated_frames:[
    fact(1,'session.created',{id:'parent',cwd:'/parent'}),
    fact(2,'turn.tool_call_started',{'call-id':'parent-call','tool-name':'shell'}),
    fact(3,'turn.tool_result',{'call-id':'parent-call',metadata:{workspace_diff:{files:[{path:'parent.ts',added:1}]},background_shell:{shell_session_id:3,status:'running'}}}),
  ]});
  assert.equal(store.view().standby,true);
  assert.equal(store.view().parts.find(p=>p.kind==='tool').call.sessionId,'parent');
  assert.deepEqual(store.view().modifiedFiles,[]);
  assert.deepEqual(store.view().processes,[]);
  store.applyFrame({type:'session_stream_resumed',session_id:'child',replay_chunk_index:1,replay_chunk_final:true,accumulated_frames:[
    fact(4,'session.created',{id:'child',cwd:'/child'}),
    fact(5,'turn.tool_result',{'call-id':'child-call',metadata:{workspace_diff:{files:[{path:'child.ts',added:2}]},background_shell:{shell_session_id:4,status:'running'}}}),
  ]});
  assert.equal(store.view().standby,false);
  assert.equal(store.view().cwd,'/child');
  assert.deepEqual(store.view().modifiedFiles.map(f=>f.path),['child.ts']);
  assert.deepEqual(store.view().processes.map(p=>p.id),['4']);
});

test('a delayed background exit updates its owning turn, even when the call ID is reused later',()=>{
  const store=new SessionStore();
  const fact=(sequence,type,turn_id,payload={})=>({...event(sequence,type,payload),turn_id,session_id:'own'});
  store.setThreads([],'own');
  store.applyFrames([
    fact(1,'turn.started','one'),
    fact(2,'turn.input_committed','one',{message:'first'}),
    fact(3,'turn.tool_call_started','one',{'call-id':'shared','tool-name':'shell'}),
    fact(4,'turn.tool_result','one',{'call-id':'shared',result:'backgrounded',metadata:{background_shell:{shell_session_id:7,status:'running'}}}),
    fact(5,'turn.completed','one'),
    fact(6,'turn.started','two'),
    fact(7,'turn.input_committed','two',{message:'second'}),
    fact(8,'turn.tool_call_started','two',{'call-id':'shared','tool-name':'shell'}),
    fact(9,'turn.tool_result','one',{'call-id':'shared',result:'finished',metadata:{background_shell:{shell_session_id:7,status:'exited',exit_code:0}}}),
  ]);
  const tools=store.view().parts.filter(p=>p.kind==='tool');
  assert.equal(tools.length,2);
  assert.equal(tools[0].turnNumber,1);
  assert.equal(tools[0].call.result,'finished');
  assert.equal(tools[0].call.status,'done');
  assert.equal(tools[0].call.metadata.background_shell.status,'exited');
  assert.equal(tools[1].turnNumber,2);
  assert.equal(tools[1].call.done,false);
  assert.equal(tools[1].call.result,undefined);
});


test('unscoped tool-call IDs are not reconciled across different turns',()=>{
  const store=new SessionStore();
  store.applyFrames([
    event(1,'turn.started'),
    event(2,'turn.tool_call_started',{'call-id':'reused','tool-name':'shell'}),
    event(3,'turn.tool_result',{'call-id':'reused',result:'first'}),
    event(4,'turn.completed'),
    event(5,'turn.started'),
    event(6,'turn.tool_call_started',{'call-id':'reused','tool-name':'shell'}),
  ]);
  const tools=store.view().parts.filter(p=>p.kind==='tool');
  assert.equal(tools.length,2);
  assert.equal(tools[0].call.result,'first');
  assert.equal(tools[1].call.done,false);
});

test('a full replay rebuilds usage on the current checkpoint branch',()=>{
  const store=new SessionStore();
  store.applyFrame(event(10,'turn.usage',{'input-tokens':900,'output-tokens':90}));
  store.applyHeader({through:10,session_usage:{input:900,output:90},context_usage:{input:900}});
  store.applyFrame({type:'session_stream_resumed',session_id:'own',replay_chunk_final:true,accumulated_frames:[
    event(1,'turn.usage',{'input-tokens':100,'output-tokens':10}),
  ]});
  assert.equal(store.view().totals.input,100);
  assert.equal(store.view().totals.output,10);
  assert.equal(store.view().contextUsage.input,100);
  store.applyHeader({through:1,session_usage:{input:100,output:10},context_usage:{input:100}});
  assert.equal(store.view().totals.output,10);
});


test('a header received between replay chunks covers older usage without suppressing history',()=>{
  const store=new SessionStore();
  store.applyFrame({type:'session_stream_resumed',session_id:'own',replay_chunk_index:0,replay_chunk_final:false,accumulated_frames:[
    event(1,'turn.started'),event(2,'turn.usage',{'input-tokens':100,'output-tokens':10}),
  ]});
  store.applyHeader({through:5,session_usage:{input:300,output:30},context_usage:{input:200}});
  store.applyFrame({type:'session_stream_resumed',session_id:'own',replay_chunk_index:1,replay_chunk_final:true,accumulated_frames:[
    event(3,'turn.assistant_message_completed',{message:{content:'Replayed'}}),
    event(4,'turn.completed'),event(5,'turn.usage',{'input-tokens':200,'output-tokens':20}),
  ]});
  assert.equal(store.view().totals.input,300);
  assert.equal(store.view().totals.output,30);
  assert.equal(store.view().contextUsage.input,200);
  assert.equal(store.view().parts.find(p=>p.kind==='assistant').text,'Replayed');
});

test('replayed ancestor and child calls with the same ID keep their native ownership',()=>{
  const store=new SessionStore();
  const fact=(sequence,type,turn_id,payload={})=>({...event(sequence,type,payload),turn_id,session_id:'child'});
  store.applyFrame({type:'session_stream_resumed',session_id:'child',replay_chunk_final:true,accumulated_frames:[
    fact(1,'session.created',undefined,{id:'parent'}),
    fact(2,'turn.started','parent-turn'),
    fact(3,'turn.tool_call_started','parent-turn',{'call-id':'shared','tool-name':'shell'}),
    fact(4,'turn.tool_result','parent-turn',{'call-id':'shared',result:'parent'}),
    fact(5,'turn.completed','parent-turn'),
    fact(6,'session.created',undefined,{id:'child'}),
    fact(7,'turn.started','child-turn'),
    fact(8,'turn.tool_call_started','child-turn',{'call-id':'shared','tool-name':'shell'}),
    fact(9,'turn.tool_result','child-turn',{'call-id':'shared',result:'child'}),
  ]});
  assert.deepEqual(store.view().parts.filter(p=>p.kind==='tool').map(p=>[p.call.sessionId,p.call.turnId,p.call.result]),[
    ['parent','parent-turn','parent'],['child','child-turn','child'],
  ]);
});


test('latest recorded diff follows result completion rather than tool-start row order',()=>{
  const store=new SessionStore();store.setThreads([],'own');
  const fact=(sequence,type,turn_id,payload={})=>({...event(sequence,type,payload),session_id:'own',turn_id});
  const diff=patch=>({workspace_diff:{files:[{path:'a.ts',added:1,removed:0,patch}]}});
  const frames=[
    fact(1,'turn.started','one'),
    fact(2,'turn.tool_call_started','one',{'call-id':'background','tool-name':'shell'}),
    fact(3,'turn.tool_result','one',{'call-id':'background',metadata:diff('yield-time')}),
    fact(4,'turn.tool_call_started','one',{'call-id':'sync','tool-name':'edit'}),
    fact(5,'turn.tool_result','one',{'call-id':'sync',metadata:diff('sync')}),
    fact(6,'turn.completed','one'),
    fact(7,'turn.started','two'),
    fact(8,'turn.tool_result','one',{'call-id':'background',metadata:diff('late final')}),
  ];
  store.applyFrames(frames.slice(0,5));assert.equal(store.view().modifiedFiles[0].patch,'sync');
  store.applyFrames(frames.slice(5));
  const view=store.view();assert.equal(view.modifiedFiles[0].patch,'late final');assert.equal(view.modifiedFiles[0].changeCount,2);
  assert.deepEqual(view.parts.filter(p=>p.kind==='tool').map(p=>p.call.callId),['background','sync']);
  store.applyFrame(frames.at(-1));assert.deepEqual(store.view().modifiedFiles,view.modifiedFiles);
  store.applyFrame({type:'session_stream_resumed',session_id:'own',accumulated_frames:frames});
  assert.deepEqual(store.view().modifiedFiles,view.modifiedFiles);
});

test('recorded diff receipt counts include reused call IDs from distinct native turns',()=>{
  const store=new SessionStore();store.setThreads([],'own');
  let sequence=0;
  for(const turn_id of ['one','two']){
    const apply=(type,payload={})=>store.applyFrame({...event(++sequence,type,payload),session_id:'own',turn_id});
    apply('turn.started');apply('turn.tool_call_started',{'call-id':'same','tool-name':'edit'});
    apply('turn.tool_result',{'call-id':'same',metadata:{workspace_diff:{files:[{path:'a.ts',added:1,removed:0,patch:turn_id}]}}});apply('turn.completed');
  }
  const files=store.view().modifiedFiles;assert.equal(files[0].patch,'two');assert.equal(files[0].changeCount,2);
});


test('sequence-free diff results still follow receipt order and replay deduplication stays authoritative',()=>{
  const store=new SessionStore();store.setThreads([],'own');
  const result=(sequence,callId,patch)=>({...event(sequence,'turn.tool_result',{'call-id':callId,metadata:{workspace_diff:{files:[{path:'a.ts',patch}]}}}),session_id:'own',turn_id:'one'});
  store.applyFrame({...event(1,'turn.started'),session_id:'own',turn_id:'one'});
  store.applyFrame({...event(2,'turn.tool_call_started',{'call-id':'early','tool-name':'shell'}),session_id:'own',turn_id:'one'});
  store.applyFrame(result(3,'late','first result'));
  store.applyFrame(result(0,'early','sequence-free final'));
  assert.equal(store.view().modifiedFiles[0].patch,'sequence-free final');
  store.applyFrame(result(3,'late','duplicate replay'));
  assert.equal(store.view().modifiedFiles[0].patch,'sequence-free final');
});

test('native turn starts are steerable before any queue snapshot and matching capability updates remain authoritative',()=>{
  const store=new SessionStore();
  const apply=(sequence,type,turn_id,payload={})=>store.applyFrame({...event(sequence,type,payload),turn_id});
  apply(1,'turn.started','first');
  assert.equal(store.view().activeTurnId,'first');assert.equal(store.view().activeTurnSteerable,true);
  store.applyFrame({type:'session_input_queue_snapshot_updated',snapshot:{active_turn:'first',active_turn_steerable:false,pending_prompts:[]}});
  assert.equal(store.view().activeTurnSteerable,false);
  apply(2,'turn.completed','first');apply(3,'turn.started','second');
  assert.equal(store.view().activeTurnId,'second');assert.equal(store.view().activeTurnSteerable,true);
});

test('native queue promotions consume pending identities and old snapshots cannot mask the active turn',()=>{
  const store=new SessionStore();
  const apply=(sequence,type,turn_id,payload={})=>store.applyFrame({...event(sequence,type,payload),turn_id});
  apply(1,'turn.started','work');
  apply(2,'turn.input_committed','work',{message:'Later',disposition:'follow-up','prompt-id':'later'});
  const snapshot={version:10,active_turn:'work',active_turn_steerable:true,pending_prompts:[{prompt_id:'later',content:'Later'},{prompt_id:'correction',content:'Correction',disposition:'steer'}]};
  store.applyFrame({type:'session_input_queue_snapshot_updated',snapshot});
  assert.deepEqual(store.view().queue.map(p=>p.prompt_id),['later','correction']);
  apply(3,'turn.completed','work');
  apply(4,'turn.input_committed','steered',{message:'Correction',disposition:'started','prompt-id':'correction'});
  apply(5,'turn.started','steered');
  assert.equal(store.view().activeTurnId,'steered');assert.equal(store.view().activeTurnSteerable,true);
  assert.deepEqual(store.view().queue.map(p=>p.prompt_id),['later']);
  store.applyFrame({type:'session_input_queue_snapshot_updated',snapshot});
  assert.equal(store.view().activeTurnId,'steered');assert.equal(store.view().activeTurnSteerable,true);
  assert.deepEqual(store.view().queue.map(p=>p.prompt_id),['later']);
  apply(6,'turn.completed','steered');
  apply(7,'turn.input_committed','followup',{message:'Later',disposition:'started','prompt-id':'later'});
  apply(8,'turn.started','followup');apply(9,'turn.completed','followup');
  store.applyFrame({type:'session_input_queue_snapshot_updated',snapshot});
  assert.equal(store.view().activeTurnId,null);assert.equal(store.view().activeTurnSteerable,false);
  assert.equal(store.view().running,false);assert.deepEqual(store.view().queue,[]);
  assert.deepEqual(store.userPrompts(),['Correction','Later']);
});

test('a historical queue snapshot after a completed replay cannot resurrect delivered inputs or an ended turn',()=>{
  const store=new SessionStore();
  const fact=(sequence,type,turn_id,payload={})=>({...event(sequence,type,payload),turn_id});
  store.applyFrame({type:'session_stream_resumed',session_id:'own',replay_chunk_final:true,admission_state:'ready',accumulated_frames:[
    fact(1,'turn.started','work'),
    fact(2,'turn.input_committed','work',{message:'Later',disposition:'follow-up','prompt-id':'later'}),
    fact(3,'turn.completed','work'),
    fact(4,'turn.input_committed','next',{message:'Later',disposition:'started','prompt-id':'later'}),
    fact(5,'turn.started','next'),fact(6,'turn.completed','next'),
  ]});
  store.applyFrame({type:'session_input_queue_snapshot_updated',snapshot:{version:2,active_turn:'work',active_turn_steerable:true,pending_prompts:[{prompt_id:'later',content:'Later'}]}});
  const view=store.view();
  assert.equal(view.replayComplete,true);assert.equal(view.activeTurnId,null);assert.equal(view.activeTurnSteerable,false);
  assert.equal(view.running,false);assert.deepEqual(view.queue,[]);assert.deepEqual(store.userPrompts(),['Later']);
});


test('queue snapshot versions order only queue updates while withdrawals and new inputs remain authoritative',()=>{
  const store=new SessionStore();
  store.applyFrame({...event(100,'turn.started'),turn_id:'current'});
  store.applyFrame({...event(101,'turn.input_committed',{disposition:'started','prompt-id':'delivered',message:'Delivered'}),turn_id:'current'});
  const snapshot={version:1,active_turn:'current',active_turn_steerable:true,pending_prompts:[{prompt_id:'delivered'},{prompt_id:'withdrawn'}]};
  store.applyFrame({type:'session_input_queue_snapshot_updated',snapshot});
  assert.deepEqual(store.view().queue.map(p=>p.prompt_id),['withdrawn']);
  store.applyFrame({type:'session_input_queue_snapshot_updated',snapshot:{...snapshot,version:2,pending_prompts:[{prompt_id:'new-steer',disposition:'steer'}]}});
  assert.deepEqual(store.view().queue.map(p=>p.prompt_id),['new-steer']);
  store.applyFrame({type:'session_input_queue_snapshot_updated',snapshot});
  assert.deepEqual(store.view().queue.map(p=>p.prompt_id),['new-steer']);
  assert.equal(store.view().activeTurnId,'current');assert.equal(store.view().activeTurnSteerable,true);
  store.applyFrame({type:'session_stream_resumed',session_id:'own',replay_chunk_final:true,admission_state:'active',accumulated_frames:[{...event(1,'turn.started'),turn_id:'replacement'}]});
  store.applyFrame({type:'session_input_queue_snapshot_updated',snapshot:{version:1,active_turn:'replacement',active_turn_steerable:true,pending_prompts:[{prompt_id:'delivered'}]}});
  assert.deepEqual(store.view().queue.map(p=>p.prompt_id),['delivered'],'a replacement branch must rebuild consumed identities');
});
