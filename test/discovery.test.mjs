import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,Module} from 'node:module';
const require=createRequire(import.meta.url),load=Module._load;
class EventEmitter {
  constructor(){this.listeners=new Set();}
  event=(listener)=>{this.listeners.add(listener);return {dispose:()=>this.listeners.delete(listener)};};
  fire(value){for(const listener of this.listeners)listener(value);}
  dispose(){this.listeners.clear();}
}
Module._load=function(name,...args){return name==='vscode'?{EventEmitter}:load.call(this,name,...args);};
const {NodecodeDiscovery}=require('../out/discovery.js');Module._load=load;
function harness(){const discovery=new NodecodeDiscovery({log(){}});discovery.readToken=()=>'';return discovery;}

test('a stale discovery failure cannot clear a newer healthy endpoint',async()=>{
  const discovery=harness(),pings=[];let port=1234;
  discovery.readOwner=()=>({port,pid:1});discovery.ping=()=>new Promise(resolve=>pings.push(resolve));
  try{
    const older=discovery.probe();port=5678;const newer=discovery.probe();
    pings[1](true);assert.equal((await newer).port,5678);
    pings[0](false);assert.equal((await older).port,5678,'the stale probe answers with what is known now');
    assert.equal(discovery.current().port,5678,'and the page keeps framing the endpoint that answered');
  }finally{discovery.dispose();}
});

test('a stale discovery success cannot revive an endpoint superseded by a newer failed probe',async()=>{
  const discovery=harness(),pings=[];let port=1234;
  discovery.readOwner=()=>({port,pid:1});discovery.ping=()=>new Promise(resolve=>pings.push(resolve));
  try{
    const older=discovery.probe();port=5678;const newer=discovery.probe();
    pings[1](false);assert.equal(await newer,null);
    pings[0](true);assert.equal(await older,null,'the gateway that answered late is not the one that is gone');
    assert.equal(discovery.current(),null,'and no page is framed for it');
  }finally{discovery.dispose();}
});

test('owner file ports must be valid TCP integers before probing',async()=>{
  const discovery=harness();let pings=0;discovery.ping=async()=>{pings++;return true;};
  try{
    for(const port of [-1,0,65536,1.5,NaN,Infinity,'1234',null]){
      discovery.readOwner=()=>({port,pid:1});
      assert.equal(await discovery.probe(),null,`invalid port ${String(port)}`);
      assert.equal(discovery.current(),null,`invalid port ${String(port)} frames nothing`);
    }
    assert.equal(pings,0,'an invalid port is not worth a socket');
    for(const port of [1,65535]){discovery.readOwner=()=>({port,pid:1});assert.equal((await discovery.probe()).port,port);}
  }finally{discovery.dispose();}
});

test('synchronous HTTP construction failures settle discovery as unreachable',async()=>{
  const discovery=harness();discovery.readOwner=()=>({port:1234,pid:1});discovery.readToken=()=> 'invalid\nheader';
  try{assert.equal(await discovery.probe(),null);assert.equal(discovery.current(),null);}
  finally{discovery.dispose();}
});

test('a rotated operator token is a change the view hears about',async()=>{
  const discovery=harness();let token='first';
  discovery.readOwner=()=>({port:1234,pid:1});discovery.readToken=()=>token;discovery.ping=async()=>true;
  const seen=[];discovery.onDidChange((endpoint)=>seen.push(endpoint?endpoint.token:null));
  try{
    await discovery.probe();
    assert.deepEqual(seen,['first'],'the first endpoint is announced');
    await discovery.probe();
    assert.deepEqual(seen,['first'],'an unchanged endpoint says nothing twice, so the page is not restarted');
    token='second';
    await discovery.probe();
    assert.deepEqual(seen,['first','second'],'a new token is a new page, framed with the token the gateway accepts');
    discovery.readOwner=()=>({});
    await discovery.probe();
    assert.deepEqual(seen,['first','second',null],'and a gateway that goes away is announced as gone');
  }finally{discovery.dispose();}
});

test('a gateway that restarted on the same port is a change, and carries a new revision',async()=>{
  const discovery=harness();let pid=1;
  discovery.readOwner=()=>({port:1234,pid});discovery.ping=async()=>true;
  const seen=[];discovery.onDidChange((endpoint)=>seen.push(endpoint?.pid??null));
  try{
    await discovery.probe();
    assert.equal(discovery.revision,1);
    assert.deepEqual(seen,[1]);
    await discovery.probe();
    assert.equal(discovery.revision,1,'the same gateway is not a change');
    pid=2;
    await discovery.probe();
    assert.equal(discovery.revision,2,'a new gateway process on the same port is');
    assert.deepEqual(seen,[1,2]);
    assert.equal(discovery.current().port,1234);
  }finally{discovery.dispose();}
});
