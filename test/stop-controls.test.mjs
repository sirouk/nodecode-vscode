import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const {STOP_CONTROLS_JS}=require('../out/turn-controls.js');
const context=vm.createContext({});
vm.runInContext(STOP_CONTROLS_JS,context);

// The original defect lived here: the button appeared for a running session and
// posted a cancel that named no turn. The decision is now one shared function,
// so this suite pins it without a browser.
test('stop appears only for a confirmed live turn on a synchronized, connected panel',()=>{
  const live={running:true,activeTurnId:'turn-live'};
  assert.equal(context.stopTarget(live,true,'connected'),'turn-live');
  assert.equal(context.stopTarget(live,true,'reconnecting'),null,'a dropped connection hides the target');
  assert.equal(context.stopTarget(live,false,'connected'),null,'a replaying session has no stop target yet');
  assert.equal(context.stopTarget({...live,activeTurnId:null},true,'connected'),null,'a running session without a confirmed turn id has nothing to name');
  assert.equal(context.stopTarget({...live,running:false},true,'connected'),null);
  assert.equal(context.stopTarget({...live,cached:true},true,'connected'),null,'a restored, still-syncing view has no authoritative turn to name');
  assert.equal(context.stopTarget(null,true,'connected'),null);
});

test('a stop is pending only for the turn it named',()=>{
  assert.equal(context.stopPending('turn-live','turn-live'),true);
  assert.equal(context.stopPending('turn-live','turn-next'),false,'a new turn is not what the operator asked to stop');
  assert.equal(context.stopPending(null,'turn-live'),false);
});
