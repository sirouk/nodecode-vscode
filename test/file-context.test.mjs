import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { withFileReferences, splitFileReferences, MAX_FILE_BYTES } = require('../out/file-context.js');
const { SessionStore } = require('../out/store.js');
const { SessionController } = require('../out/manager.js');

async function fixture(fn) {
  const base = await mkdtemp(join(tmpdir(), 'nodecode-files-'));
  const root = join(base, 'workspace');
  await mkdir(root);
  try { await fn(root, base); } finally { await rm(base, {recursive:true, force:true}); }
}

test('references snapshot current text, preserve fences and restore compact transcript', () => fixture(async root => {
  const file = join(root, 'source file.ts');
  await writeFile(file, 'old');
  await writeFile(file, 'latest\n```\nuntrusted text');
  const prompt = await withFileReferences(root, 'Review @source file.ts', ['source file.ts', 'source file.ts']);
  assert.match(prompt, /latest\n```\nuntrusted text/);
  assert.match(prompt, /````\nlatest/);
  assert.equal((prompt.match(/File: /g) || []).length, 1);
  assert.deepEqual(splitFileReferences(prompt), {text:'Review @source file.ts',files:['source file.ts']});
  const store = new SessionStore();
  store.applyFrame({type:'session_stream_event',sequence:1,event:{type:'turn.input_committed',payload:{message:prompt,role:'user'}}});
  assert.equal(store.view().parts[0].text, 'Review @source file.ts');
  assert.deepEqual(store.view().parts[0].files, ['source file.ts']);
  assert.deepEqual(store.userPrompts(), ['Review @source file.ts']);
  const userExample = 'Explain this marker:\n\n<nodecode-workspace-files>\n{}';
  assert.equal(splitFileReferences(await withFileReferences(root, userExample, ['source file.ts'])).text, userExample);
  const controller = new SessionController({}, {log(){}}, {}, root, 'test');
  let sent;
  controller.rpc.sendCommand = command => {sent = command;};
  controller.sendPrompt(await controller.withFileReferences('review', ['source file.ts']));
  assert.match(sent.prompt, /latest/);
  assert.equal(sent.type, 'start_turn');
  controller.dispose();
}));

test('references reject escaped paths, external symlinks and non-text or oversized files', () => fixture(async (root, base) => {
  await writeFile(join(base, 'outside'), 'private');
  await symlink(join(base, 'outside'), join(root, 'escape'));
  await writeFile(join(root, 'binary'), Buffer.from([0xFF,0x00]));
  await writeFile(join(root, 'large'), Buffer.alloc(MAX_FILE_BYTES + 1, 65));
  for (const file of ['../outside', join(base, 'outside'), 'escape']) await assert.rejects(withFileReferences(root, 'read', [file]), /inside the workspace/);
  await assert.rejects(withFileReferences(root, 'read', ['binary']), /UTF-8 text/);
  await assert.rejects(withFileReferences(root, 'read', ['large']), /100 KiB/);
  await assert.rejects(withFileReferences(root, 'read', ['.']), /inside the workspace/);
  await assert.rejects(withFileReferences(root, 'read', Array(9).fill('large')), /at most 8/);
}));

test('combined limit and invalid metadata fail without disguising ordinary user messages', () => fixture(async root => {
  for (const name of ['a','b','c']) await writeFile(join(root, name), Buffer.alloc(MAX_FILE_BYTES, 65));
  await assert.rejects(withFileReferences(root, 'read', ['a','b','c']), /256 KiB/);
  assert.equal(await withFileReferences('', 'plain', undefined), 'plain');
  const plain = 'hello\n\n<nodecode-workspace-files>\nnot JSON\n</nodecode-workspace-files>';
  assert.deepEqual(splitFileReferences(plain), {text:plain});
  await writeFile(join(root, 'empty'), '');
  assert.deepEqual(splitFileReferences(await withFileReferences(root, '', ['empty'])), {text:'',files:['empty']});
}));

test('inline mentions preserve composed words and snapshots once alongside separate attachments', () => fixture(async root => {
  await writeFile(join(root, 'source.ts'), 'export const selected = true;');
  const controller = new SessionController({}, {log(){}}, {assertLocalRuntimeFiles:async()=>{}}, root, 'inline-test', join(root, 'private'));
  const source = {};
  try {
    const attachment = await controller.textAttachments.stage('separate attachment body', 'notes.txt', source);
    const text = 'Compare @source.ts with the attached notes, then revisit @source.ts.';
    const prompt = await controller.withAttachments(text, ['source.ts', 'source.ts'], [attachment.ref], source);
    assert.equal((prompt.match(/export const selected = true;/g) || []).length, 1);
    assert(!prompt.includes('separate attachment body'));
    assert(prompt.includes(attachment.path));
    const store = new SessionStore();
    store.applyFrame({type:'session_stream_event',sequence:1,event:{type:'turn.input_committed',payload:{role:'user',message:prompt}}});
    const part = store.view().parts[0];
    assert.equal(part.text, text);
    assert.deepEqual(part.files, ['source.ts']);
    assert.deepEqual(part.textFiles, [attachment]);
    // The composer sends an empty registry after a mention is edited/deleted.
    // A remaining literal @ token never grants a file association on its own.
    const edited = 'Compare @source-edited.ts, then continue.';
    assert.equal(await controller.withAttachments(edited, [], [], source), edited);
    assert.equal(await controller.withAttachments('Continue without that reference.', [], [], source), 'Continue without that reference.');
  } finally { controller.dispose(); }
}));
