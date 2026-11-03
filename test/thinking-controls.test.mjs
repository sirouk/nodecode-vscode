import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const {THINKING_CONTROLS_JS}=require('../out/thinking-controls.js');
const context=vm.createContext({});
vm.runInContext(THINKING_CONTROLS_JS,context);
const panelSource=fs.readFileSync(new URL('../out/panel.js',import.meta.url),'utf8');

// The collapsed thought row is a preview of the whole thought cut by CSS, so the
// cut has to follow a resize rather than a character count. This suite pins the
// preview and the turn cursor without a browser.
test('a collapsed thought previews the whole text and leaves the cut to CSS',()=>{
  const short='One line of thought.';
  assert.equal(context.thoughtPreview(short),short,'a short thought is shown whole');
  assert.equal(context.thoughtPreview(undefined),'','an absent thought previews as empty');
  const long='x'.repeat(5000);
  assert.equal(context.thoughtPreview(long).length,2000,'the source is bounded so one unwrapped line stays cheap to lay out');
  assert(!context.thoughtPreview(long).includes('\u2026'),'the ellipsis is CSS text-overflow, never a character appended here');
  assert(!context.thoughtPreview(long).includes('...'),'no hand-made ellipsis either');
  assert(context.thoughtPreview('a\nb').includes('\n'),'line breaks are left for white-space:nowrap to collapse, not rewritten');
});

test('native committed prompts already belong to the next turn for thought disclosures',()=>{
  assert.equal(context.newestTurn([]),0,'an empty transcript has no turn');
  assert.equal(context.newestTurn([{kind:'user',turnNumber:2},{kind:'assistant',turnNumber:3}]),3,'the input is numbered before turn.started increments the turn');
  assert.equal(context.newestTurn([{kind:'assistant',turnNumber:3},{kind:'user',turnNumber:3}]),4,'a committed next prompt closes the preceding thought before assistant output');
  assert.equal(context.newestTurn([{kind:'user',turnNumber:3},{kind:'tool',turnNumber:4}]),4,'the next turn and its input share one disclosure boundary');
  assert.equal(context.newestTurn([{kind:'assistant'},{}]),0,'parts without a turn number cannot move the cursor');
  assert.equal(context.newestTurn([{turnNumber:7},{turnNumber:2}]),7,'the newest turn wins wherever it sits in the window');
});

test('the webview truncates the preview with CSS overflow, not with layout math',()=>{
  assert(panelSource.includes('class="reasoning-snippet"'),'the collapsed row carries a preview element');
  const rule=panelSource.match(/\.reasoning summary>\.reasoning-snippet\{([^}]*)\}/);
  assert(rule,'the preview has its own rule');
  for(const property of ['text-overflow:ellipsis','white-space:nowrap','min-width:0','overflow:hidden']) assert(rule[1].includes(property),'the preview rule carries '+property);
  assert(panelSource.includes('.reasoning[open]>summary>.reasoning-snippet{display:none}'),'an open thought does not repeat itself in its own header');
  assert(!/function grow\(\)\{[^}]*\b180\b/.test(panelSource),'composer growth is capped by CSS max-height, not by a number copied into the script');
});
