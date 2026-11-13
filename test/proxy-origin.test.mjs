import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {startGatewayProxy,originAllowed}=require('../out/proxy.js');
const {withBridge}=require('../out/proxy.js');

/** An upstream that records what reached it, so a refused request can be shown never to arrive. */
async function upstream(){
  const seen=[];
  const sockets=new Set();
  const server=http.createServer((request,response)=>{
    seen.push(`${request.method} ${request.url} origin=${request.headers.origin ?? 'none'}`);
    response.writeHead(200,{'content-type':'text/html; charset=utf-8'});
    response.end('<html>the page</html>');
  });
  server.on('upgrade',(request,socket)=>{
    seen.push(`UPGRADE origin=${request.headers.origin ?? 'none'}`);
    sockets.add(socket);
    socket.on('close',()=>sockets.delete(socket));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
  return {port:server.address().port,seen,close:()=>{for(const socket of sockets)socket.destroy();server.close();}};
}

const get=(url,headers)=>new Promise((resolve)=>{
  const request=http.request(url,{method:'GET',headers},(response)=>{let body='';response.on('data',(chunk)=>{body+=chunk;});response.on('end',()=>resolve({status:response.statusCode,body}));});
  request.on('error',()=>resolve({status:0,body:''}));
  request.end();
});

const socketHandshake=(url,origin)=>new Promise((resolve)=>{
  const socket=net.connect(Number(new URL(url).port),'127.0.0.1',()=>{
    socket.write(`GET /gateway HTTP/1.1\r\nHost: ${new URL(url).host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${origin?`Origin: ${origin}\r\n`:''}\r\n`);
  });
  let buffer='';
  socket.on('data',(chunk)=>{buffer+=chunk.toString('latin1');if(buffer.includes('\r\n\r\n')){socket.destroy();resolve({status:buffer.split('\r\n')[0],head:buffer});}});
  socket.on('error',()=>resolve({status:'',head:buffer}));
  setTimeout(()=>{socket.destroy();resolve({status:'',head:buffer});},1500);
});

test('an origin is allowed only when it is the host the page was served from',()=>{
  assert.equal(originAllowed(undefined,'127.0.0.1:53117'),true,'a navigation sends no origin');
  assert.equal(originAllowed('http://127.0.0.1:53117','127.0.0.1:53117'),true);
  assert.equal(originAllowed('HTTP://127.0.0.1:53117','127.0.0.1:53117'),true,'scheme case does not matter');
  assert.equal(originAllowed('https://abc-53117.devtunnels.ms','abc-53117.devtunnels.ms'),true,'a forwarded host is the same authority');
  assert.equal(originAllowed('https://evil.example','127.0.0.1:53117'),false);
  assert.equal(originAllowed('null','127.0.0.1:53117'),false,'an opaque origin is not this page');
  assert.equal(originAllowed('http://127.0.0.1:53117',undefined),false,'nor is an origin with no host to match');
  assert.equal(originAllowed(['http://a'],'a'),false,'two origins are never one request');
});

test('a page from elsewhere cannot drive the gateway through the proxy',async()=>{
  const target=await upstream();
  const proxy=await startGatewayProxy({host:'127.0.0.1',port:target.port});
  try{
    const own=await get(`${proxy.origin}/web/`,{host:new URL(proxy.origin).host});
    assert.equal(own.status,200,'the page itself is served');
    assert.equal(own.body,'<html>the page</html><script src="nodecode-bridge.js"></script>');

    const sameOrigin=await get(`${proxy.origin}/api/act`,{origin:proxy.origin,host:new URL(proxy.origin).host});
    assert.equal(sameOrigin.status,200,'the page acting on its own origin is served');

    const foreign=await get(`${proxy.origin}/api/act`,{origin:'https://evil.example',host:new URL(proxy.origin).host});
    assert.equal(foreign.status,403);
    assert.equal(foreign.body,'the page only answers itself');
    assert.ok(!target.seen.some((line)=>line.includes('evil')),'and it never reached the gateway');

    const foreignSocket=await socketHandshake(`${proxy.origin}/gateway`,'https://evil.example');
    assert.match(foreignSocket.status,/403/);
    assert.ok(!target.seen.includes('UPGRADE origin=https://evil.example'),'no cross-site socket reaches the gateway');

    const ownSocket=await socketHandshake(`${proxy.origin}/gateway`,proxy.origin);
    assert.match(ownSocket.status,/101/,'the page\'s own socket still opens');
  }finally{proxy.dispose();target.close();}
});

test('a proxy says whether it is still listening',async()=>{
  const target=await upstream();
  const proxy=await startGatewayProxy({host:'127.0.0.1',port:target.port});
  assert.equal(proxy.listening(),true);
  proxy.dispose();
  await new Promise((resolve)=>setTimeout(resolve,50));
  assert.equal(proxy.listening(),false,'so a dead proxy is never handed to the view again');
  target.close();
});
