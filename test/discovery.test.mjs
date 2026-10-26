import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,Module} from 'node:module';
const require=createRequire(import.meta.url),load=Module._load;
class EventEmitter {event=()=>({dispose(){}});fire(){}dispose(){}}
Module._load=function(name,...args){return name==='vscode'?{EventEmitter}:load.call(this,name,...args);};
const {NodecodeDiscovery}=require('../out/discovery.js');Module._load=load;
function harness(){const discovery=new NodecodeDiscovery({log(){}});discovery.readToken=()=>'';return discovery;}

test('a stale discovery failure cannot clear a newer healthy endpoint',async()=>{
  const discovery=harness(),pings=[];let port=1234;
  discovery.readOwner=()=>({port,pid:1});discovery.ping=()=>new Promise(resolve=>pings.push(resolve));
  try{
    const older=discovery.probe();port=5678;const newer=discovery.probe();
    pings[1](true);assert.equal((await newer).port,5678);
    pings[0](false);assert.equal((await older).port,5678);
    assert.equal(discovery.current().port,5678);assert.equal(discovery.canRestore,false);
  }finally{discovery.dispose();}
});

test('a stale discovery success cannot revive an endpoint superseded by a newer failed probe',async()=>{
  const discovery=harness(),pings=[];let port=1234;
  discovery.readOwner=()=>({port,pid:1});discovery.ping=()=>new Promise(resolve=>pings.push(resolve));
  try{
    const older=discovery.probe();port=5678;const newer=discovery.probe();
    pings[1](false);assert.equal(await newer,null);assert.equal(discovery.canRestore,true);
    pings[0](true);assert.equal(await older,null);
    assert.equal(discovery.current(),null);assert.equal(discovery.canRestore,true);
  }finally{discovery.dispose();}
});

test('owner file ports must be valid TCP integers before probing',async()=>{
  const discovery=harness();let pings=0;discovery.ping=async()=>{pings++;return true;};
  try{
    for(const port of [-1,0,65536,1.5,NaN,Infinity,'1234',null]){
      discovery.readOwner=()=>({port,pid:1});
      assert.equal(await discovery.probe(),null,`invalid port ${String(port)}`);
      assert.equal(discovery.canRestore,false);
    }
    assert.equal(pings,0);
    for(const port of [1,65535]){discovery.readOwner=()=>({port,pid:1});assert.equal((await discovery.probe()).port,port);}
  }finally{discovery.dispose();}
});

test('synchronous HTTP construction failures settle discovery as unreachable',async()=>{
  const discovery=harness();discovery.readOwner=()=>({port:1234,pid:1});discovery.readToken=()=> 'invalid\nheader';
  try{assert.equal(await discovery.probe(),null);assert.equal(discovery.canRestore,true);}
  finally{discovery.dispose();}
});
