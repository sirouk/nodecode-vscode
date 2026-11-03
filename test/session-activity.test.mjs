import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {BackgroundProcesses,recordedFileChanges,recordedFilePath}=require('../out/session-activity.js');
const {SessionStore}=require('../out/store.js');
const {SessionController}=require('../out/manager.js');
const b64=bytes=>Buffer.from(bytes).toString('base64');

test('native process byte offsets preserve UTF8, deduplicate overlap and bound retained output',()=>{
  const processes=new BackgroundProcesses();
  const bytes=Buffer.from('a😀z');
  processes.update({shell_session_id:7,status:'running',command:'test',offset:0,output_b64:b64(bytes.subarray(0,3))});
  assert.equal(processes.view()[0].output,'a');
  processes.update({shell_session_id:7,status:'running',offset:3,output_b64:b64(bytes.subarray(3))});
  assert.equal(processes.view()[0].output,'a😀z');
  processes.update({shell_session_id:7,status:'running',offset:0,output_b64:b64(bytes)});
  assert.equal(processes.view()[0].output,'a😀z');
  processes.update({shell_session_id:7,status:'running',offset:bytes.length,output_b64:b64('x'.repeat(70000))});
  const truncated=processes.view()[0];assert.equal(truncated.output.length,65536);assert.equal(truncated.outputTruncated,true);
  processes.update({shell_session_id:7,status:'running',offset:0,output_b64:b64('old')});
  assert.equal(processes.view()[0].output,truncated.output);
  processes.update({shell_session_id:7,status:'exited',exit_code:130,stopped:{by:'operator'}});
  assert.equal(processes.view()[0].exitCode,130);assert.equal(processes.view()[0].status,'exited');
});

test('recorded modified files use latest native call metadata rather than summing repeated snapshots',()=>{
  const parts=[{kind:'tool',call:{callId:'one',metadata:{workspace_diff:{files:[{path:'a.ts',added:3,removed:1,patch:'one'}]}}}},{kind:'tool',call:{callId:'two',metadata:{workspace_diff:{files:[{path:'a.ts',added:1,removed:2,patch:'two'},{path:'image.png',added:0,removed:0,binary:true}]}}}}];
  const files=recordedFileChanges(parts);
  assert.deepEqual(files[0],{path:'a.ts',added:1,removed:2,binary:false,patch:'two',callId:'two',changeCount:2});
  assert.equal(files[1].binary,true);
  assert.deepEqual(recordedFileChanges([{kind:'tool',call:{callId:'shell',metadata:{}}}]),[]);
});

test('a latest receipt without a patch does not misattribute an older call\'s patch',()=>{
  const parts=[
    {kind:'tool',call:{callId:'one',diffOrder:1,metadata:{workspace_diff:{files:[{path:'src/diff-view.ts',added:102,removed:0,patch:'+++ created'}]}}}},
    {kind:'tool',call:{callId:'two',diffOrder:2,metadata:{workspace_diff:{files:[{path:'src/diff-view.ts',added:4,removed:1}]}}}}
  ];
  const [file]=recordedFileChanges(parts);
  assert.equal(file.patch,undefined,'missing native patch stays unavailable; the old patch remains in its tool row');
  assert.equal(parts[0].call.metadata.workspace_diff.files[0].patch,'+++ created');
  assert.equal(file.added,4);
  assert.equal(file.removed,1);
  assert.equal(file.callId,'two');
  assert.equal(file.changeCount,2);
});

test('binary changes never inherit an older text patch',()=>{
  const parts=[
    {kind:'tool',call:{callId:'text',diffOrder:1,metadata:{workspace_diff:{files:[{path:'a.ts',patch:'old text'}]}}}},
    {kind:'tool',call:{callId:'binary',diffOrder:2,metadata:{workspace_diff:{files:[{path:'a.ts',added:0,removed:0,binary:true}]}}}}
  ];
  const [file]=recordedFileChanges(parts);
  assert.equal(file.binary,true);
  assert.equal(file.patch,undefined);
  assert.equal(file.callId,'binary');
});

test('truncation describes only the latest receipt, even when its patch is absent',()=>{
  const first={kind:'tool',call:{callId:'one',diffOrder:1,metadata:{workspace_diff:{truncated:true,files:[{path:'a.ts',patch:'cut'}]}}}};
  for(const truncated of [false,true]){
    const last={kind:'tool',call:{callId:'two',diffOrder:2,metadata:{workspace_diff:{truncated,files:[{path:'a.ts',added:1,removed:0}]}}}};
    const [file]=recordedFileChanges([first,last]);
    assert.equal(file.patch,undefined);
    assert.equal(file.truncated,truncated?true:undefined,'an older receipt does not supply the new label');
  }
});

// Foreign sessions never enter this store, so an unattributed receipt can only be
// its own; refusing it dropped a real change.
test('a receipt the store could not attribute still counts, another session\'s does not',()=>{
  const call=(callId,sessionId,path)=>({kind:'tool',call:{callId,...(sessionId?{sessionId}:{}),metadata:{workspace_diff:{files:[{path,patch:callId}]}}}});
  assert.deepEqual(recordedFileChanges([call('mine',undefined,'a.ts'),call('theirs','other','b.ts'),call('here','this','c.ts')],'this').map(file=>file.path),['a.ts','c.ts']);
});

test('one file is one row whatever spelling the tool used',()=>{
  assert.equal(recordedFilePath('./src/a.ts'),'src/a.ts');
  assert.equal(recordedFilePath('src//a.ts'),'src/a.ts');
  assert.equal(recordedFilePath('src/a.ts/'),'src/a.ts');
  assert.equal(recordedFilePath('//server/share/a.ts'),'//server/share/a.ts','a root-relative share keeps its root');
  assert.equal(recordedFilePath('/abs/a.ts'),'/abs/a.ts','an absolute path is not guessed at');
  assert.equal(recordedFilePath('./'),'./','nothing is left of an empty path, so the original stands');
  const parts=[
    {kind:'tool',call:{callId:'one',diffOrder:1,metadata:{workspace_diff:{files:[{path:'src/a.ts',patch:'first'}]}}}},
    {kind:'tool',call:{callId:'two',diffOrder:2,metadata:{workspace_diff:{files:[{path:'./src//a.ts',patch:'second'}]}}}}
  ];
  const files=recordedFileChanges(parts);
  assert.equal(files.length,1,'two spellings of one path are one row');
  assert.equal(files[0].changeCount,2);
});

test('native child discovery emits one navigable notice only after initial roster',()=>{
  const store=new SessionStore();const child={id:'child',parent_id:'root',title:'Research',source:'fork',relation:'inherited'};
  store.setThreads([{id:'historical',parent_id:'root',source:'fork'}],'root');
  assert.equal(store.view().parts.length,0);
  store.setThreads([child],'root');store.setThreads([child],'root');
  assert.equal(store.view().parts.filter(p=>p.childSessionId==='child').length,1);
  store.applyFrame({type:'session_stream_resumed',session_id:'root',accumulated_frames:[]});
  store.setThreads([child],'root');
  assert.equal(store.view().parts.filter(p=>p.childSessionId==='child').length,0);
});

test('interrupt routes a numeric ID only for this session current running process',()=>{
  const controller=new SessionController({}, {log(){}}, {}, '', 'own');const commands=[];
  controller.rpc.sendCommand=command=>commands.push(command);
  controller.store.applyFrame({type:'session_stream_resumed',session_id:'own',replay_chunk_final:true,accumulated_frames:[]});controller.rpc.setState('connected');
  controller.store.applyFrame({type:'session_background_process_updated',session_id:'other',process:{shell_session_id:99,status:'running'}});
  assert.throws(()=>controller.interruptExec('99'),/not running/);
  controller.store.applyFrame({type:'session_background_process_updated',session_id:'own',process:{shell_session_id:7,status:'running'}});
  controller.interruptExec('7');assert.deepEqual(commands,[{type:'interrupt_exec',exec_id:7}]);
  controller.store.applyFrame({type:'session_background_process_updated',session_id:'own',process:{shell_session_id:7,status:'exited'}});
  assert.throws(()=>controller.interruptExec(7),/not running/);controller.dispose();
});

test('inherited parent history does not attribute parent files or processes to the child',()=>{
  const store=new SessionStore();
  const fact=(sequence,session_id,type,payload)=>({type:'session_stream_event',sequence,session_id,event:{type,payload}});
  store.applyFrame({type:'session_stream_resumed',session_id:'child',accumulated_frames:[
    fact(1,'parent','session.created',{id:'parent'}),
    fact(2,'parent','turn.tool_result',{'call-id':'parent-call',metadata:{workspace_diff:{files:[{path:'parent.ts',added:1,removed:0}]},background_shell:{shell_session_id:3,status:'running'}}}),
    fact(3,'child','session.created',{id:'child'}),
    fact(4,'child','turn.tool_result',{'call-id':'child-call',metadata:{workspace_diff:{files:[{path:'child.ts',added:2,removed:0}]}}}),
  ]});
  assert.equal(store.view().sessionId,'child');
  assert.deepEqual(store.view().modifiedFiles.map(f=>f.path),['child.ts']);
  assert.equal(store.view().processes.length,0);
  assert.equal(store.view().parts.filter(p=>p.kind==='tool').length,2);
});

test('reused registry id starts a fresh output buffer and clears old exit data',()=>{
  const processes=new BackgroundProcesses();
  processes.update({shell_session_id:7,tool_call_id:'old',status:'exited',exit_code:1,error:'old failure',offset:0,output_b64:b64('old')});
  processes.update({shell_session_id:7,tool_call_id:'new',status:'running',offset:0,output_b64:b64('new')});
  const current=processes.view()[0];assert.equal(current.output,'new');assert.equal(current.exitCode,undefined);assert.equal(current.error,undefined);assert.equal(current.toolCallId,'new');
});


test('explicit native tail_cut survives initial and replacement byte snapshots',()=>{
  for(const text of ['', 'partial output']) {
    const processes=new BackgroundProcesses();
    processes.update({shell_session_id:7,status:'exited',offset:0,output_b64:b64(text),tail_cut:true});
    assert.equal(processes.view()[0].outputTruncated,true);
    assert.equal(processes.view()[0].output,text);
  }
  const processes=new BackgroundProcesses();
  processes.update({shell_session_id:7,status:'running',offset:0,output_b64:b64('before')});
  processes.update({shell_session_id:7,status:'exited',offset:100,output_b64:b64('after'),tail_cut:true});
  assert.equal(processes.view()[0].outputTruncated,true);
  assert.equal(processes.view()[0].output,'after');
});


test('recorded diff receipts distinguish session and turn ownership while deduplicating a repeated call',()=>{
  const tool=(sessionId,turnId,patch)=>({kind:'tool',call:{sessionId,turnId,callId:'reused',metadata:{workspace_diff:{files:[{path:'a.ts',added:1,removed:0,patch}]}}}});
  const parts=[tool('own','one','first'),tool('own','one','repeated'),tool('own','two','second'),tool('parent','one','parent')];
  const own=recordedFileChanges(parts,'own');
  assert.equal(own[0].changeCount,2);assert.equal(own[0].patch,'second');
  assert.equal(recordedFileChanges(parts)[0].changeCount,3);
  const unscoped=[1,2].map(turnNumber=>({kind:'tool',turnNumber,call:{callId:'same',metadata:{workspace_diff:{files:[{path:'b.ts'}]}}}}));
  assert.equal(recordedFileChanges(unscoped)[0].changeCount,2);
});

test('recorded diff metadata rejects malformed rows and keeps invalid line counts unknown',()=>{
  for(const invalid of [-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'2',null]){
    const files=recordedFileChanges([{kind:'tool',call:{callId:'one',metadata:{workspace_diff:{files:[null,false,'path',{},[],{path:''},{path:4},{path:'a.ts',added:invalid,removed:invalid}]}}}}]);
    assert.equal(files.length,1);assert.equal(files[0].added,undefined);assert.equal(files[0].removed,undefined);
  }
  const zero=recordedFileChanges([{kind:'tool',call:{callId:'one',metadata:{workspace_diff:{files:[{path:'zero.ts',added:0,removed:0}]}}}}])[0];
  assert.equal(zero.added,0);assert.equal(zero.removed,0);
});

test('explicit legacy diff truncation is retained only when the native document marks it',()=>{
  for(const truncated of [true,false,undefined]){
    const files=recordedFileChanges([{kind:'tool',call:{callId:'one',metadata:{workspace_diff:{truncated,files:[{path:'a.ts',patch:'retained patch'}]}}}}]);
    assert.equal(files[0].truncated,truncated===true?true:undefined);
    assert.equal(Object.hasOwn(files[0],'truncated'),truncated===true);
  }
});
