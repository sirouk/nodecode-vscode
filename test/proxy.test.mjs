import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {startGatewayProxy,stripFrameAncestors,frameableHeaders,upgradeHead}=require('../out/proxy.js');

const PAGE='<!doctype html><html><body>the gateway page</body></html>';
const CSP="default-src 'self'; connect-src 'self'; frame-ancestors 'none'";

async function upstream(){
  const sockets=new Set();
  const server=http.createServer((request,response)=>{
    if(request.url==='/web/'){
      response.writeHead(200,{'content-type':'text/html; charset=utf-8','content-security-policy':CSP,'x-frame-options':'DENY','cache-control':'no-cache','x-kept':'yes'});
      response.end(PAGE);
      return;
    }
    if(request.url==='/missing'){response.writeHead(404,{'content-type':'text/plain'});response.end('nope');return;}
    response.writeHead(200,{'content-type':'application/json'});
    response.end(JSON.stringify({host:request.headers.host,origin:request.headers.origin??null}));
  });
  server.on('upgrade',(request,socket)=>{
    sockets.add(socket);
    socket.on('close',()=>sockets.delete(socket));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.write(JSON.stringify({seen:request.rawHeaders}));
    socket.on('data',(chunk)=>socket.write(chunk));
  });
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
  return {server,port:server.address().port,close:()=>{for(const socket of sockets)socket.destroy();server.close();}};
}

test('the framing directive is dropped and every other directive kept',()=>{
  assert.equal(stripFrameAncestors(CSP),"default-src 'self'; connect-src 'self'");
  assert.equal(stripFrameAncestors("frame-ancestors 'none'"),'');
  assert.equal(stripFrameAncestors("default-src 'self';frame-ancestors*;img-src 'self'"),"default-src 'self'; img-src 'self'");
  assert.equal(stripFrameAncestors("default-src 'self'"),"default-src 'self'");
});

test('the browser never sees a refusal to frame it',()=>{
  const headers=frameableHeaders({'content-type':'text/html','content-security-policy':CSP,'x-frame-options':'DENY','set-cookie':['a=1']});
  assert.equal(headers['content-security-policy'],"default-src 'self'; connect-src 'self'");
  assert.equal(headers['x-frame-options'],undefined);
  assert.equal(headers['content-type'],'text/html');
  assert.deepEqual(headers['set-cookie'],['a=1']);
  assert.equal(upgradeHead({method:'GET',url:'/gateway',rawHeaders:['Host','127.0.0.1:1','Origin','http://127.0.0.1:1']}),'GET /gateway HTTP/1.1\r\nHost: 127.0.0.1:1\r\nOrigin: http://127.0.0.1:1\r\n\r\n');
});

test('the page comes through byte for byte, framable, and its assets too',async()=>{
  const target=await upstream();
  const proxy=await startGatewayProxy({host:'127.0.0.1',port:target.port});
  try{
    const response=await fetch(`${proxy.origin}/web/`);
    assert.equal(response.status,200);
    assert.equal(await response.text(),PAGE);
    assert.equal(response.headers.get('content-security-policy'),"default-src 'self'; connect-src 'self'");
    assert.equal(response.headers.get('x-frame-options'),null);
    assert.equal(response.headers.get('x-kept'),'yes');
    assert.equal((await fetch(`${proxy.origin}/missing`)).status,404);
    const json=await (await fetch(`${proxy.origin}/`)).json();
    assert.equal(json.host,`127.0.0.1:${proxy.port}`,'the gateway sees the proxy as the request host');
  }finally{proxy.dispose();target.close();}
});

test('the page socket opens through the proxy and carries both ways',async()=>{
  const target=await upstream();
  const proxy=await startGatewayProxy({host:'127.0.0.1',port:target.port});
  try{
    const answered=await new Promise((resolve,reject)=>{
      const socket=net.connect(proxy.port,'127.0.0.1',()=>{
        socket.write('GET /gateway HTTP/1.1\r\nHost: 127.0.0.1:'+proxy.port+'\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: http://127.0.0.1:'+proxy.port+'\r\n\r\n');
      });
      let buffer='';
      socket.on('data',(chunk)=>{
        buffer+=chunk.toString('utf8');
        if(!buffer.includes('\r\n\r\n'))return;
        const rest=buffer.slice(buffer.indexOf('\r\n\r\n')+4);
        if(buffer.includes('101')&&!rest.startsWith('{'))return;
        const seen=JSON.parse(rest.slice(rest.indexOf('{'),rest.lastIndexOf('}')+1)).seen;
        if(!seen)return;
        socket.write('hello');
        socket.once('data',(echo)=>{socket.destroy();resolve({status:buffer.split('\r\n')[0],seen,echo:echo.toString('utf8')});});
      });
      socket.on('error',reject);
      setTimeout(()=>{socket.destroy();reject(new Error('no handshake'));},5000);
    });
    assert.match(answered.status,/101/);
    assert.match(answered.echo,/hello/);
    const pairs=new Map();
    for(let index=0;index<answered.seen.length;index+=2)pairs.set(answered.seen[index].toLowerCase(),answered.seen[index+1]);
    assert.equal(pairs.get('host'),`127.0.0.1:${proxy.port}`,'the handshake reaches the gateway as the browser wrote it');
    assert.equal(pairs.get('origin'),`http://127.0.0.1:${proxy.port}`);
  }finally{proxy.dispose();target.close();}
});

test('a gateway that is gone answers as gone, and the proxy closes cleanly',async()=>{
  const target=await upstream();
  const port=target.port;
  const proxy=await startGatewayProxy({host:'127.0.0.1',port});
  target.close();
  try{
    const response=await fetch(`${proxy.origin}/web/`);
    assert.equal(response.status,502);
    assert.match(await response.text(),/did not answer/);
  }finally{proxy.dispose();}
  await new Promise((resolve)=>setTimeout(resolve,50));
  assert.ok(proxy.port>0);
});
