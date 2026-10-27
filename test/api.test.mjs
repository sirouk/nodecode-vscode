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
