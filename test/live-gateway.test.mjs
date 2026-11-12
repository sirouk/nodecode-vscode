// The whole point, against the gateway on this machine: its page is served,
// the proxy makes it framable, the page's assets arrive, the operator token is
// accepted, and the socket the page opens at /gateway upgrades. Skips when no
// gateway is running, so the suite stays green on a machine without one.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {createRequire,Module} from 'node:module';
const require=createRequire(import.meta.url),load=Module._load;
class EventEmitter{event=()=>({dispose(){}});fire(){}dispose(){}}
Module._load=function(name,...args){return name==='vscode'?{EventEmitter,Uri:{parse:(value)=>({toString:()=>value})},env:{asExternalUri:async(uri)=>uri}}:load.call(this,name,...args);};
const {startGatewayProxy}=require('../out/proxy.js');
const {servesWebPage,pageLink}=require('../out/gateway.js');

const home=process.env.NODECODE_HOME||path.join(os.homedir(),'.nodecode');
function owner(){try{return JSON.parse(fs.readFileSync(path.join(home,'history.db.owner'),'utf8'));}catch{return undefined;}}
function token(){try{return fs.readFileSync(path.join(home,'operator-token'),'utf8').trim();}catch{return '';}}
const live=owner();
const skip=!live?.port?'no gateway running in this home':false;

function upgrade(port,origin=`http://127.0.0.1:${port}`){
  return new Promise((resolve)=>{
    const socket=net.connect(port,'127.0.0.1',()=>{
      socket.write(`GET /gateway HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`);
    });
    let buffer='';
    socket.on('data',(chunk)=>{buffer+=chunk.toString('latin1');if(buffer.includes('\r\n\r\n')){socket.destroy();resolve(buffer.split('\r\n')[0]);}});
    socket.on('error',(error)=>resolve(`error ${error.message}`));
    setTimeout(()=>{socket.destroy();resolve(`timeout ${JSON.stringify(buffer.slice(0,40))}`);},5000);
  });
}

test('the gateway serves its own page, and the proxy makes it framable',{skip},async()=>{
  const endpoint={baseUrl:`http://127.0.0.1:${live.port}`,token:token(),port:live.port,pid:live.pid??0,restorable:false};
  assert.equal(await servesWebPage(endpoint.baseUrl),true,'the web cell answers /web/');
  const proxy=await startGatewayProxy({host:'127.0.0.1',port:live.port});
  try{
    const page=await fetch(`${proxy.origin}/web/`);
    assert.equal(page.status,200);
    assert.match(page.headers.get('content-type')??'',/text\/html/);
    assert.doesNotMatch(page.headers.get('content-security-policy')??'',/frame-ancestors/,'the page may be framed by the view');
    const html=await page.text();
    assert.match(html,/Nodecode/);
    const script=await fetch(`${proxy.origin}/web/app.js`);
    assert.equal(script.status,200);
    assert.ok((await script.text()).length>10000,'the page ships its own client');
    const tasks=await fetch(`${proxy.origin}/api/web/tasks`,{headers:{authorization:`Bearer ${endpoint.token}`}});
    assert.equal(tasks.status,200,'the operator token rides through the proxy');
    assert.match(pageLink(endpoint),/^http:\/\/127\.0\.0\.1:\d+\/web\/#t=./);
  }finally{proxy.dispose();}
});

test('the page socket opens through the proxy',{skip},async()=>{
  const proxy=await startGatewayProxy({host:'127.0.0.1',port:live.port});
  try{
    const line=await upgrade(proxy.port);
    assert.match(line,/101 Switching Protocols/,'the gateway accepts the handshake through the proxy');
    // What the proxy exists to prevent is a page of another origin opening the socket:
    // the gateway refuses that origin outright, which is why the view frames loopback.
    assert.match(await upgrade(live.port,'vscode-webview://panel'),/403/,'a foreign origin is refused');
  }finally{proxy.dispose();}
});
