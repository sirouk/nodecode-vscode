import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createRequire,Module} from 'node:module';
const require=createRequire(import.meta.url),load=Module._load;
class EventEmitter{event=()=>({dispose(){}});fire(){}dispose(){}}
Module._load=function(name,...args){
  if(name!=='vscode')return load.call(this,name,...args);
  return {EventEmitter,Uri:{parse:(value)=>({toString:()=>value})},env:{asExternalUri:async(uri)=>uri}};
};
const {Gateway,servesWebPage,pageLink,pageUrl}=require('../out/gateway.js');
Module._load=load;

const TOKEN='token-abc';
function cliMock(overrides={}){
  return {version:'nodecode 1.0',versionError:()=>'',resolve:()=>'/usr/bin/nodecode',readVersion(){return this.version;},
    enableWebCell:async()=>({code:0,stdout:'',stderr:'',timedOut:false}),startGateway:async()=>({code:0,stdout:'',stderr:'',timedOut:false}),...overrides};
}
const endpoint=(port)=>({baseUrl:`http://127.0.0.1:${port}`,token:TOKEN,port,pid:1,restorable:false});
const discoveryMock=(value)=>({current:()=>value,probe:async()=>value});

function notes(){const lines=[];return {log:(line)=>lines.push(line),lines};}

test('a gateway that serves its own page answers true, and one that does not answers false',async()=>{
  const server=http.createServer((request,response)=>{
    if(request.url==='/web/'){response.writeHead(200,{'content-type':'text/html; charset=utf-8'});response.end('<html></html>');return;}
    response.writeHead(404,{'content-type':'text/html'});response.end('missing');
  });
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    assert.equal(await servesWebPage(base),true);
    assert.equal(await servesWebPage(`${base}/nothing-here`),false);
    assert.equal(await servesWebPage('http://127.0.0.1:1'),false,'a dead port is not a page');
  }finally{server.close();}
});

test('the page link carries the operator token in the fragment, and its port follows the gateway',()=>{
  assert.equal(pageLink(endpoint(50171)),`http://127.0.0.1:50171/web/#t=${TOKEN}`);
  assert.equal(pageUrl('http://127.0.0.1:53117/',endpoint(50171)),`http://127.0.0.1:53117/web/#t=${TOKEN}`);
  assert.equal(pageLink({...endpoint(1),token:'a b&c'}),'http://127.0.0.1:1/web/#t=a%20b%26c');
});

test('nothing installed is its own state, not a gateway failure',async()=>{
  const state=await new Gateway(cliMock({resolve:()=>undefined}),discoveryMock(null),notes()).status();
  assert.equal(state.state,'missing-cli');
  assert.match(state.installCommand,/nodecode\.ai\/install\.sh/);
});

test('a nodecode that will not start is named as such',async()=>{
  const state=await new Gateway(cliMock({versionError:()=>'command failed'}),discoveryMock(null),notes()).status();
  assert.equal(state.state,'unusable-cli');
  assert.match(state.message,/would not start: command failed/);
});

test('a stopped gateway asks for a gateway, and a gateway without the cell asks for the cell',async()=>{
  assert.equal((await new Gateway(cliMock(),discoveryMock(null),notes()).status()).state,'gateway-down');
  const server=http.createServer((_request,response)=>{response.writeHead(404);response.end('no');});
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
  try{
    const state=await new Gateway(cliMock(),discoveryMock(endpoint(server.address().port)),notes()).status();
    assert.equal(state.state,'web-cell-off');
    assert.match(state.message,/without the web cell/);
  }finally{server.close();}
});

test('ready puts a proxy in front of the gateway and hands the view that page',async()=>{
  let host='';
  const server=http.createServer((request,response)=>{
    host=request.headers.host??'';
    response.writeHead(200,{'content-type':'text/html; charset=utf-8'});
    response.end('<html>the page</html>');
  });
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
  const gateway=new Gateway(cliMock(),discoveryMock(endpoint(server.address().port)),notes());
  try{
    const framed=await gateway.frame();
    assert.equal(framed.status.state,'ready');
    assert.match(framed.pageUrl,/^http:\/\/127\.0\.0\.1:\d+\/web\/#t=token-abc$/);
    assert.match(framed.pageOrigin,/^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(framed.pageOrigin,`http://127.0.0.1:${server.address().port}`,'the view frames the proxy, never the gateway port itself');
    const answer=await fetch(framed.pageUrl.split('#')[0]);
    assert.equal(answer.status,200);
    assert.equal(await answer.text(),'<html>the page</html>');
    // The gateway refuses a handshake whose Host and Origin disagree, so the
    // proxy keeps the browser's own loopback authority instead of rewriting it.
    assert.equal(host,framed.pageOrigin.replace('http://',''),'the gateway is asked under one loopback authority');
  }finally{gateway.dispose();server.close();}
});

test('the proxy follows the gateway to a new port instead of caching the old one',async()=>{
  const ports=[];
  const servers=await Promise.all([0,1].map(()=>new Promise((resolve)=>{
    const server=http.createServer((_request,response)=>{response.writeHead(200,{'content-type':'text/html'});response.end('<html></html>');});
    server.listen(0,'127.0.0.1',()=>{ports.push(server.address().port);resolve(server);});
  })));
  let current=endpoint(ports[0]);
  const discovery={current:()=>current,probe:async()=>current};
  const gateway=new Gateway(cliMock(),discovery,notes());
  try{
    const first=await gateway.frame();
    current=endpoint(ports[1]);
    const second=await gateway.frame();
    assert.notEqual(first.pageOrigin,second.pageOrigin);
    assert.equal((await fetch(`${second.pageOrigin}/web/`)).status,200);
  }finally{gateway.dispose();for(const server of servers)server.close();}
});

test('a gateway that stopped between the probe and the frame is reported, not framed',async()=>{
  const gateway=new Gateway(cliMock(),{current:()=>null,probe:async()=>null},notes());
  const framed=await gateway.frame();
  assert.equal(framed.status.state,'gateway-down');
  assert.equal(framed.pageUrl,undefined);
  gateway.dispose();
});
