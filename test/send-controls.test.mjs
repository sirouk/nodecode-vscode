import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const {decideSend,SEND_CONTROLS_JS}=require('../out/send-controls.js');
const context=vm.createContext({});
vm.runInContext(SEND_CONTROLS_JS,context);

// A message typed at a busy thread was once refused outright, which read as a
// hung send. The CLI's own answer is to steer or to queue, so the decision is one
// function and this suite pins it for the webview and the controller at once.
test('a busy thread steers when it has a target and queues when it does not',()=>{
  assert.deepEqual(decideSend({running:true,activeTurnId:'turn-A',activeTurnSteerable:true}),{mode:'steer',turnId:'turn-A'});
  assert.deepEqual(decideSend({running:true,activeTurnId:'turn-A',activeTurnSteerable:false}),{mode:'queue'},'an unsteerable turn still takes the message');
  assert.deepEqual(decideSend({running:true,activeTurnId:null}),{mode:'queue'},'a turn without a confirmed id is busy, not closed');
  assert.deepEqual(decideSend({running:false,activeTurnId:null}),{mode:null},'an idle session starts a turn');
  assert.deepEqual(decideSend({running:false,activeTurnId:'turn-A',activeTurnSteerable:true}),{mode:'steer',turnId:'turn-A'},'a live turn is live whether or not the collector reports it running');
  assert.deepEqual(decideSend(null),{mode:null});
});

test('the webview takes the same decision as the controller for every view',()=>{
  const views=[
    undefined,null,{},
    {running:false,activeTurnId:null,activeTurnSteerable:false},
    {running:true,activeTurnId:'turn-A',activeTurnSteerable:true},
    {running:true,activeTurnId:'turn-A',activeTurnSteerable:false},
    {running:true,activeTurnId:null,activeTurnSteerable:false},
    {running:true,activeTurnId:null,activeTurnSteerable:true},
    {running:false,activeTurnId:'turn-A',activeTurnSteerable:true},
    {running:true,activeTurnId:'turn-A'},
    {running:true,activeTurnId:'',activeTurnSteerable:true},
    {activeTurnId:'turn-A'}
  ];
  for(const view of views) assert.equal(JSON.stringify(context.decideSend(view)),JSON.stringify(decideSend(view)),'view '+JSON.stringify(view));
});
