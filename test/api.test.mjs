import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { NodecodeApi } = require('../out/api.js');

test('gateway requests preserve session target and assign new session identity', async () => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({url:req.url, method:req.method, body:body ? JSON.parse(body) : undefined, auth:req.headers.authorization});
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.method === 'POST' ? {session_id: JSON.parse(body).session_id} : {model: 'model'}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const api = new NodecodeApi({current:() => ({baseUrl:`http://127.0.0.1:${server.address().port}`,token:'test-token'})}, {log(){}});
    await api.target('session/with spaces');
    const created = await api.createSession({cwd:'/workspace',parent:'parent',anchor_turn_id:'turn'});
    assert.equal(requests[0].url, '/api/gateway/target?session_id=session%2Fwith%20spaces');
    assert.equal(requests[0].auth, 'Bearer test-token');
    assert.match(created.session_id, /^session-[a-f0-9-]{36}$/);
    assert.deepEqual(requests[1].body, {session_id:created.session_id,cwd:'/workspace',parent:'parent',anchor_turn_id:'turn'});
    const child = await api.forkSession('parent', 'historical-turn');
    assert.deepEqual(requests[2].body, {session_id:child,parent:'parent',anchor_turn_id:'historical-turn'});
    assert.equal(requests[2].method, 'POST');
    assert.equal(requests[2].url, '/api/gateway/sessions');
    await api.sessionDetail('session/with spaces');
    assert.equal(requests[3].url, '/api/gateway/sessions/session%2Fwith%20spaces');
    assert.equal(requests[3].method, 'GET');
  } finally {server.close(); await once(server,'close');}
});


test('overlapping roster reads share one HTTP request without sharing mutable results or retaining a settled snapshot',async()=>{
  const rows=[{id:'root',title:'Root',prompt:''},{id:'child',title:'Child',prompt:'',parent_id:'root',waits:{why:'asked'},lanes:[{id:'lane'}]}];
  let requests=0,release;const gate=new Promise(resolve=>{release=resolve;});
  const server=http.createServer(async(req,res)=>{requests++;await gate;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(rows));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const api=new NodecodeApi({current:()=>({baseUrl:`http://127.0.0.1:${server.address().port}`,token:'test'})},{log(){}});
    const reads=Array.from({length:40},()=>api.sessions());release();
    const results=await Promise.all(reads);
    assert.equal(requests,1,'a simultaneous controller refresh fetches the full roster once');
    assert.deepEqual(results[0],rows);assert.notEqual(results[0],results[1]);assert.notEqual(results[0][1],results[1][1]);
    results[0].reverse();results[0][0].title='Edited by one caller';results[0][0].waits.why='failed';results[0][0].lanes[0].id='other';
    assert.deepEqual(results[1],rows,'picker sorting and nested row edits remain private to their caller');
    const {SessionStore}=require('../out/store.js'),root=new SessionStore(),child=new SessionStore();
    root.setThreads(results[1],'root');child.setThreads(results[2],'child');
    assert.deepEqual(root.view().descendants.map(row=>row.id),['child']);assert.deepEqual(child.view().ancestors.map(row=>row.id),['root']);
    assert.equal(root.view().threads[0].status,'waiting');assert.equal(child.view().currentThread.id,'child');
    await api.sessions();assert.equal(requests,2,'a completed response is never reused as a TTL cache');
  }finally{release();server.close();await once(server,'close');}
});

test('coalescing preserves the existing empty and non-JSON response handling',async()=>{
  let requests=0;
  const server=http.createServer((req,res)=>{res.end(requests++?'not JSON':'');});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const api=new NodecodeApi({current:()=>({baseUrl:`http://127.0.0.1:${server.address().port}`,token:'test'})},{log(){}});
    assert.deepEqual(await Promise.all([api.sessions(),api.sessions()]),[undefined,undefined]);
    assert.deepEqual(await Promise.all([api.sessions(),api.sessions()]),['not JSON','not JSON']);assert.equal(requests,2);
  }finally{server.close();await once(server,'close');}
});

test('a shared roster failure rejects every reader and the next request retries normally',async()=>{
  let requests=0;
  const server=http.createServer((req,res)=>{requests++;res.setHeader('Content-Type','application/json');res.statusCode=requests===1?503:200;res.end(JSON.stringify(requests===1?{error:'unavailable'}:[{id:'recovered',title:'Recovered',prompt:''}]));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const api=new NodecodeApi({current:()=>({baseUrl:`http://127.0.0.1:${server.address().port}`,token:'test'})},{log(){}});
    const results=await Promise.allSettled(Array.from({length:40},()=>api.sessions()));
    assert.equal(requests,1);assert(results.every(result=>result.status==='rejected'&&/503/.test(String(result.reason))));
    assert.equal((await api.sessions())[0].id,'recovered');assert.equal(requests,2);
  }finally{server.close();await once(server,'close');}
});

test('in-flight rosters stay scoped to endpoint and authorization, and old completion cannot discard newer work',async t=>{
  for(const field of ['baseUrl','token','pid'])await t.test(field,async()=>{
    const requests=[],responses=[];let received;const firstReceived=new Promise(resolve=>{received=resolve;});
    const serve=(req,res)=>{requests.push(req.headers.authorization);if(requests.length>2){res.end(JSON.stringify([{id:'new',title:'New',prompt:''}]));return;}responses.push(res);received();};
    const firstServer=http.createServer(serve),secondServer=http.createServer(serve);
    firstServer.listen(0,'127.0.0.1');secondServer.listen(0,'127.0.0.1');await Promise.all([once(firstServer,'listening'),once(secondServer,'listening')]);
    let endpoint={baseUrl:`http://127.0.0.1:${firstServer.address().port}`,token:'first',pid:1};
    const api=new NodecodeApi({current:()=>endpoint},{log(){}});
    try{
      const first=api.sessions();await firstReceived;
      let secondReceived;const nextReceived=new Promise(resolve=>{secondReceived=resolve;});received=secondReceived;
      endpoint={...endpoint,[field]:field==='baseUrl'?`http://127.0.0.1:${secondServer.address().port}`:field==='token'?'second':2};
      const second=api.sessions();await nextReceived;
      responses[0].end(JSON.stringify([{id:'old',title:'Old',prompt:''}]));await first;
      const joined=api.sessions();
      endpoint=null;await assert.rejects(api.sessions(),/not reachable/);
      responses[1].end(JSON.stringify([{id:'new',title:'New',prompt:''}]));
      assert.deepEqual(await second,await joined);assert.equal(requests.length,2);
      assert.deepEqual(requests,field==='token'?['Bearer first','Bearer second']:['Bearer first','Bearer first']);
    }finally{for(const response of responses)response.end('[]');firstServer.close();secondServer.close();await Promise.all([once(firstServer,'close'),once(secondServer,'close')]);}
  });
});

test('native roster freshness separates old requests while subsequent peers still coalesce',async()=>{
  const requests=[];
  const api=new NodecodeApi({current:()=>({baseUrl:'http://synthetic.local',token:'test'})},{log(){}});
  api.request=()=>new Promise(resolve=>requests.push(resolve));
  const old=api.sessions(),notBefore=process.hrtime.bigint();
  const fresh=Array.from({length:40},()=>api.sessions(notBefore));
  assert.equal(requests.length,2,'controllers refreshing after one native event share its new request');
  requests[0](JSON.stringify([{id:'old',title:'Old',prompt:''}]));await old;
  const joined=api.sessions();
  requests[1](JSON.stringify([{id:'new',title:'New',prompt:''}]));
  const results=await Promise.all([...fresh,joined]);
  assert.equal(requests.length,2,'old completion cannot clear the newer request');
  assert(results.every(rows=>rows[0].id==='new'));assert.notEqual(results[0],results[1]);
});

test('roster reads after session mutations cannot join a pre-mutation request',async t=>{
  for(const [name,mutate] of [
    ['create',api=>api.createSession({cwd:'/workspace'})],
    ['delete',api=>api.deleteSession('changed')],
    ['rename',api=>api.setTitle('changed','New title')],
  ])await t.test(name,async()=>{
    let requests=0,oldResponse,firstReceived;const received=new Promise(resolve=>{firstReceived=resolve;});
    const server=http.createServer((req,res)=>{
      res.setHeader('Content-Type','application/json');
      if(req.method==='GET'&&req.url==='/api/gateway/sessions'){
        requests++;
        if(requests===1){oldResponse=res;firstReceived();return;}
        res.end(JSON.stringify([{id:'changed',title:'After mutation',prompt:''}]));return;
      }
      res.end(JSON.stringify({session_id:'changed',sessions:['changed'],title:'New title'}));
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    try{
      const api=new NodecodeApi({current:()=>({baseUrl:`http://127.0.0.1:${server.address().port}`,token:'test'})},{log(){}});
      const stale=api.sessions();await received;await mutate(api);
      const fresh=api.sessions();
      oldResponse.end(JSON.stringify([{id:'changed',title:'Before mutation',prompt:''}]));await stale;
      assert.equal((await fresh)[0].title,'After mutation');assert.equal(requests,2);
    }finally{oldResponse?.end('[]');server.close();await once(server,'close');}
  });
});

test('history search combines title matches with deduplicated native content hits', async () => {
  const requests=[];
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    requests.push({url:req.url,method:req.method,body:body?JSON.parse(body):undefined});
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify(req.method==='POST'?{query:'needle & "quoted"',rows:[
      {session_id:'content',title:'Content hit',snippet:'needle in the conversation'},
      {session_id:'content',title:'Content hit',snippet:'second hit same session'},
      {session_id:'title',title:'needle & "quoted"',snippet:'also a content match'}
    ]}:[{id:'title',title:'needle & "quoted"',prompt:'',updated_at:'2026-01-02'},{id:'other',title:'Other',prompt:''}]));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const api=new NodecodeApi({current:()=>({baseUrl:`http://127.0.0.1:${server.address().port}`,token:'test'})},{log(){}});
    const rows=await api.searchSessions('needle & "quoted"');
    assert.deepEqual(rows.map(r=>r.id),['title','content']);
    assert.equal(rows.find(r=>r.id==='content').matchSnippet,'needle in the conversation');
    assert.deepEqual(requests.find(r=>r.method==='POST'),{url:'/api/gateway/sessions/search',method:'POST',body:{query:'needle & "quoted"',limit:60}});
  }finally{server.close();await once(server,'close');}
});

test('model catalog preserves context and listing diagnostics; target preview is read-only and model-specific', async () => {
  const requests=[];
  const catalog={models:[{provider:'lane/name',model:'model + reasoner',name:'Reasoner',context:1050000}],unlisted:[{provider:'lane/name',reason:'listing timed out'}],providers:[{id:'lane/name',connected:true,listable:true,local:false,ready:true}]};
  const target={provider:'lane/name',model:'model + reasoner',effort:null,efforts:[],pin:null,default:{provider:'default',model:'default'},unconfigured:false,refusal:null};
  const server=http.createServer((req,res)=>{requests.push({url:req.url,method:req.method});res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/api/gateway/models'?catalog:target));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const api=new NodecodeApi({current:()=>({baseUrl:`http://127.0.0.1:${server.address().port}`,token:'test'})},{log(){}});
    assert.deepEqual(await api.models(),catalog);
    assert.deepEqual(await api.targetForModel('lane/name','model + reasoner'),target);
    assert.deepEqual(requests,[{url:'/api/gateway/models',method:'GET'},{url:'/api/gateway/target?provider=lane%2Fname&model=model%20%2B%20reasoner',method:'GET'}]);
  }finally{server.close();await once(server,'close');}
});

test('native slash and service lifecycle use exact control endpoints, not model prompts',async()=>{
  const requests=[];
  const catalog={commands:[{name:'help',description:'Help',session:false},{name:'models',description:'Models',autocomplete:true,session:true}]};
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    requests.push({method:req.method,url:req.url,body:body?JSON.parse(body):undefined});
    res.setHeader('Content-Type','application/json');
    const value=req.url==='/api/gateway/slash'&&req.method==='GET'?catalog:req.url.endsWith('/completions')?{choices:[{name:'provider/model',value:'provider model'}]}:req.url.endsWith('/service')?{pid:123,runs:'serve',restart:{able:true,text:'Restart'}}:{text:'Done',runs:'serve'};
    res.end(JSON.stringify(value));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const api=new NodecodeApi({current:()=>({baseUrl:`http://127.0.0.1:${server.address().port}`,token:'test'})},{log(){}});
    assert.deepEqual(await api.slashCommands(),catalog.commands);
    assert.equal((await api.runSlash('/help','session')).text,'Done');
    assert.deepEqual(await api.slashCompletions('models','prov','session'),[{name:'provider/model',value:'provider model'}]);
    assert.equal((await api.service()).restart.able,true);await api.restart();
    assert.deepEqual(requests,[
      {method:'GET',url:'/api/gateway/slash',body:undefined},
      {method:'POST',url:'/api/gateway/slash',body:{line:'/help',session_id:'session'}},
      {method:'POST',url:'/api/gateway/slash/completions',body:{name:'models',text:'prov',session_id:'session'}},
      {method:'GET',url:'/api/gateway/service',body:undefined},
      {method:'POST',url:'/api/gateway/restart',body:undefined},
    ]);
  }finally{server.close();await once(server,'close');}
});

test('native model roles preserve explicit defaults, decider identities and failover order',async()=>{
  const requests=[];
  const auxiliary={provider:null,model:null,effort:null,efforts:[]};
  const decider={provider:null,model:null,base_url:null,deciders:[{id:'local-judge',name:'Local judge',model:'probability-model',base_url:'http://127.0.0.1:9000',local:true}]};
  const failover={chain:[{provider:'p1',model:'first',answered_at:null,tried:2,rescued:1},{provider:'p2',model:'second',answered_at:'2026-01-01',tried:1,rescued:1}],triggers:[{id:'rate_limit',label:'rate limit',on:true},{id:'outage',label:'outage',on:true},{id:'slow_start',label:'slow start',on:false},{id:'broken_answer',label:'broken answer',on:false},{id:'refusal',label:'refusal',on:false}]};
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    requests.push({method:req.method,url:req.url,body:body?JSON.parse(body):undefined});
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify(req.url.endsWith('auxiliary-model')?auxiliary:req.url.endsWith('decider-model')?decider:req.url.endsWith('/test')?{results:[{provider:'p1',model:'first',ok:true,reason:null,seconds:0.1}]}:failover));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const api=new NodecodeApi({current:()=>({baseUrl:`http://127.0.0.1:${server.address().port}`,token:'test'})},{log(){}});
    assert.deepEqual(await api.auxiliaryModel(),auxiliary);assert.deepEqual(await api.deciderModel(),decider);assert.deepEqual(await api.failover(),failover);
    assert.equal(requests.filter(r=>r.method==='POST').length,0,'opening role tabs never calls a provider test or mutation');
    await api.setAuxiliaryModel(null,null);await api.setAuxiliaryModel('p','reasoner',null);await api.setAuxiliaryModel('p','reasoner','high');
    await api.setDeciderModel(null);await api.setDeciderModel('local-judge','probability-model');
    const chain=[{provider:'p2',model:'second'},{provider:'p1',model:'first'}];
    await api.setFailover({chain});await api.setFailover({on:[]});
    assert.deepEqual(requests.slice(3).map(r=>r.body),[
      {provider:null,model:null},{provider:'p',model:'reasoner',effort:null},{provider:'p',model:'reasoner',effort:'high'},
      {provider:null},{provider:'local-judge',model:'probability-model'},{chain},{on:[]},
    ]);
    assert(!requests.some(r=>r.url.endsWith('/test')));
    assert.equal((await api.testFailover()).results[0].ok,true);
    assert.deepEqual(requests.at(-1),{method:'POST',url:'/api/gateway/failover/test',body:{}});
  }finally{server.close();await once(server,'close');}
});


test('truncated gateway response rejects instead of leaving the request pending',async()=>{
  const server=http.createServer((req,res)=>{
    res.writeHead(200,{'Content-Type':'application/json','Content-Length':'1000'});
    res.write('{"partial":');
    setTimeout(()=>res.destroy(),10);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  let timer;
  try{
    const api=new NodecodeApi({current:()=>({baseUrl:`http://127.0.0.1:${server.address().port}`,token:''})},{log(){}});
    const result=await Promise.race([
      api.request('GET','/truncated',undefined,50).then(()=>({resolved:true}),error=>({error})),
      new Promise(resolve=>{timer=setTimeout(()=>resolve({pending:true}),250);}),
    ]);
    assert.equal(result.pending,undefined,'request still pending after response socket was destroyed');
    assert.match(String(result.error),/aborted|reset|closed|terminated/i);
  }finally{clearTimeout(timer);server.close();await once(server,'close');}
});

test('cache validation reads one exact durable event without using wire sequence or changing history',async()=>{
  const requests=[],server=http.createServer((req,res)=>{
    requests.push({method:req.method,url:req.url});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({frames:[{seq:41,event:{metadata:{event_id:'durable-id'}}}]}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const api=new NodecodeApi({current:()=>({baseUrl:`http://127.0.0.1:${server.address().port}`,token:'test'})},{log(){}});
    assert.equal(await api.historyEventId('session/one',41),'durable-id');assert.equal(await api.historyEventId('session/one',42),undefined);
    assert.deepEqual(requests,[{method:'GET',url:'/api/gateway/sessions/session%2Fone/history?before=42&limit=1'},{method:'GET',url:'/api/gateway/sessions/session%2Fone/history?before=43&limit=1'}]);
  }finally{server.close();await once(server,'close');}
});

test('saved images use authenticated binary retrieval without exposing the operator token in a URL',async()=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZcToAAAAASUVORK5CYII=','base64'),requests=[];
  const server=http.createServer((req,res)=>{
    requests.push({method:req.method,url:req.url,auth:req.headers.authorization});
    if(req.url.endsWith('/denied')){res.writeHead(401,{'Content-Type':'application/json'});res.end('{"error":"operator_auth_failed"}');return;}
    if(req.url.endsWith('/not-image')){res.writeHead(200,{'Content-Type':'text/html'});res.end('<html>not an image</html>');return;}
    res.writeHead(200,{'Content-Type':'image/png','Content-Length':png.length});
    res.write(png.subarray(0,17));res.end(png.subarray(17));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const api=new NodecodeApi({current:()=>({baseUrl:`http://127.0.0.1:${server.address().port}`,token:'private-test-token'})},{log(){}});
    const source=await api.imageDataUrl('session/with spaces','image/one & two');
    assert.equal(source,'data:image/png;base64,'+png.toString('base64'));
    assert.deepEqual(Buffer.from(source.split(',')[1],'base64'),png,'binary bytes must never pass through UTF-8 decoding');
    assert.deepEqual(requests[0],{method:'GET',url:'/api/gateway/sessions/session%2Fwith%20spaces/images/image%2Fone%20%26%20two',auth:'Bearer private-test-token'});
    assert(!source.includes('private-test-token'));
    await assert.rejects(api.imageDataUrl('session','denied'),/401/);
    await assert.rejects(api.imageDataUrl('session','not-image'),/unsupported.*image|image.*type/i);
    assert(requests.every(request=>!request.url.includes('?')&&request.auth==='Bearer private-test-token'));
  }finally{server.close();await once(server,'close');}
});

test('truncated saved-image responses reject rather than producing a corrupt data URI',async()=>{
  const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'image/png','Content-Length':'1000'});res.write(Buffer.from([137,80,78,71]));setTimeout(()=>res.destroy(),10);});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const api=new NodecodeApi({current:()=>({baseUrl:`http://127.0.0.1:${server.address().port}`,token:'test'})},{log(){}});
    await assert.rejects(api.imageDataUrl('session','partial'),/aborted|reset|closed|terminated/i);
  }finally{server.close();await once(server,'close');}
});
