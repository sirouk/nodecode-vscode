// Attach and probe command decoding; empty prompts are rejected before admission.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { NodecodeApi } = require('../out/api.js');
const { RpcProcess } = require('../out/rpc.js');
const { SessionStore } = require('../out/store.js');

test('live discovered gateway: session target and actual RPC replay', { timeout: 15000 }, async t => {
  const home = process.env.NODECODE_HOME || path.join(os.homedir(), '.nodecode');
  let owner, token;
  try {
    owner = JSON.parse(fs.readFileSync(path.join(home, 'history.db.owner'), 'utf8'));
    token = fs.readFileSync(path.join(home, 'operator-token'), 'utf8').trim();
  } catch { t.skip('No local Nodecode gateway discovered'); return; }
  const endpoint = { baseUrl: `http://127.0.0.1:${owner.port}`, token };
  const api = new NodecodeApi({ current: () => endpoint }, { log() {} });
  const rows = await api.sessions();
  assert.deepEqual(await api.searchSessions("nodecode-no-match-history-probe-" + Date.now()), []);
  if (!rows.length) { t.skip('Gateway has no existing sessions to attach'); return; }
  const id = rows[0].id;
  const target = await api.target(id);
  assert.equal(typeof target, 'object');
  const store = new SessionStore();
  const rpc = new RpcProcess({ spawnRpc: sessionId => spawn(process.env.NODECODE_BIN || 'nodecode', ['rpc', sessionId], { stdio: ['pipe', 'pipe', 'pipe'] }) }, { log() {} }, process.cwd(), id);
  try {
    const replay = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No normalized session replay received within 8 seconds')), 8000);
      rpc.onFrame = frame => {
        store.applyFrame(frame);
        if (frame.type === 'session_stream_resumed' && frame.replay_chunk_final !== false) { clearTimeout(timer); resolve(frame); }
      };
    });
    rpc.start();
    const frame = await replay;
    assert.equal(rpc.connectionState, 'connected');
    assert.equal(store.view().sessionId, id);
    assert(Array.isArray(frame.accumulated_frames));
    assert(frame.accumulated_frames.every(f => f.type === 'session_stream_event' && Number.isFinite(f.sequence)));
    for (const command of [{type:'start_turn',prompt:''}, {type:'steer_turn',prompt:'',expected_turn_id:'invalid-probe-turn'}]) {
      const sent = rpc.sendCommand(command);
      const result = await sent.done;
      assert.equal(result.command_id, sent.commandId);
      assert.equal(result.status, 'rejected');
      assert.equal(result.code, 'invalid_request');
      assert.match(result.message, /non-empty prompt/);
    }
    const state = rpc.sendCommand({type:'get_state'});
    assert.equal((await state.done).status, 'accepted');
    // A nonexistent expected turn guarantees no image prompt can be admitted.
    // Admission rejection after decoding proves the native image wire is accepted.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZcToAAAAASUVORK5CYII=';
    const imageProbe = rpc.sendCommand({type:'steer_turn', expected_turn_id:'nonexistent-image-probe-turn', prompt:'image decoder probe', content:[{type:'text',text:'image decoder probe'},{type:'image',source:{type:'base64',media_type:'image/png',data:png}}]});
    const imageResult = await imageProbe.done;
    assert.equal(imageResult.status, 'rejected');
    assert.notEqual(imageResult.code, 'invalid_request');
    assert.match(imageResult.message, /no active turn|active turn|match/i);
  } finally { rpc.dispose(); }
});
