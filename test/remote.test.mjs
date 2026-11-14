import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire,Module} from 'node:module';

const require = createRequire(import.meta.url), load = Module._load;
Module._load = function (name, ...args) {
  return name === 'vscode' ? { env: { clipboard: { writeText: async () => {} } } } : load.call(this, name, ...args);
};
const { readRemote, actRemote } = require('../out/remote.js');
const { installBundledCell, cellFolder, REMOTE_CELL } = require('../out/cells.js');
Module._load = load;

const endpoint = { baseUrl: 'http://127.0.0.1:50171', token: 'tok', port: 50171, pid: 1 };
const answer = (status, body) => async () => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'nodecode-remote-'));
  try { return await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('a read maps the route the cell answers', async () => {
  const body = {
    available: true, running: true, https_port: 8443,
    address: 'https://host.ts.net:8443/web/', code: 'ABCD-EFGH', code_minutes: 10,
    devices: [{ index: 0, name: 'an iPhone', login: 'someone@example.com' }],
  };
  const read = await readRemote(endpoint, answer(200, body));
  assert.equal(read.kind, 'ok');
  assert.equal(read.state.running, true);
  assert.equal(read.state.httpsPort, 8443);
  assert.equal(read.state.address, 'https://host.ts.net:8443/web/');
  assert.deepEqual(read.state.devices, [{ index: 0, name: 'an iPhone', login: 'someone@example.com' }]);
});

test('a home without the cell answers 404, and that is said as missing', async () => {
  const read = await readRemote(endpoint, answer(404, ''));
  assert.equal(read.kind, 'missing');
});

test('a gateway that will not answer is unreachable, not missing', async () => {
  const read = await readRemote(endpoint, async () => { throw new Error('connect ECONNREFUSED'); });
  assert.equal(read.kind, 'unreachable');
  assert.match(read.why, /ECONNREFUSED/);
  assert.equal((await readRemote(endpoint, answer(500, 'no'))).kind, 'unreachable');
});

test('an action posts what it was told, and reads back what changed', async () => {
  const seen = [];
  const doFetch = async (url, init) => {
    seen.push({ url, method: init.method, body: JSON.parse(init.body), auth: init.headers.authorization });
    return { status: 200, ok: true, json: async () => ({ available: true, running: true, devices: [] }), text: async () => '' };
  };
  const read = await actRemote(endpoint, { action: 'forget', index: 2 }, doFetch);
  assert.equal(read.kind, 'ok');
  assert.equal(seen[0].url, 'http://127.0.0.1:50171/api/remote');
  assert.equal(seen[0].method, 'POST');
  assert.deepEqual(seen[0].body, { action: 'forget', index: 2 });
  assert.equal(seen[0].auth, 'Bearer tok');
});

test('a refused action says what the cell said', async () => {
  const read = await actRemote(endpoint, { action: 'start' }, answer(409, { error: { message: 'tailscale would not serve it: https is off' } }));
  assert.equal(read.kind, 'unreachable');
  assert.match(read.why, /tailscale would not serve it/);
});

test('the cell is installed once, and never over a home that has it', async () => {
  await fixture(async (root) => {
    const extension = join(root, 'extension');
    await mkdir(join(extension, 'resources', 'remote'), { recursive: true });
    await writeFile(join(extension, 'resources', 'remote', `${REMOTE_CELL}.asd`), 'asd');
    await writeFile(join(extension, 'resources', 'remote', 'remote.lisp'), 'lisp');
    const home = join(root, 'home');
    const first = installBundledCell(extension, home);
    assert.equal(first.copied, true);
    assert.equal(first.path, cellFolder(home));
    assert.deepEqual((await readdir(first.path)).sort(), [`${REMOTE_CELL}.asd`, 'remote.lisp'].sort());
    assert.equal(await readFile(join(first.path, 'remote.lisp'), 'utf8'), 'lisp');
    const again = installBundledCell(extension, home);
    assert.equal(again.copied, false);
  });
});
