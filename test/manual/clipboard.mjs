// Copy, cut, paste, select all and undo, in the real editor.
//
// The one thing no Node test can prove: a keystroke is performed by VS Code
// itself, so whether the framed page receives it is a fact about the editor,
// not about this code. This drives a real VS Code window with the extension
// loaded, presses the real chords, and reads back the field and the system
// clipboard. Run it after anything that touches the webview, the proxy or the
// page's own keyboard.
//
//   npm run compile
//   PW=/path/to/playwright node test/manual/clipboard.mjs
//
// PW names a playwright install (it is not a dependency of this extension).
// On macOS it sends raw key events through the debugger protocol, because
// playwright's own Meta+C/Meta+V would perform the edit for the page and prove
// nothing about whether VS Code delivers the key.

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pw = process.env.PW;
if (!pw) {
  console.error('PW names a playwright install: PW=/path/to/playwright node test/manual/clipboard.mjs');
  process.exit(2);
}
const require = createRequire(import.meta.url);
const { _electron } = require(pw);
const code = process.env.CODE || (process.platform === 'darwin' ? '/Applications/Visual Studio Code.app/Contents/MacOS/Code' : 'code');
const mac = process.platform === 'darwin';
const home = '/tmp/nodecode-clipboard-check';
const userData = path.join(home, 'user'), extensions = path.join(home, 'ext'), workspace = path.join(home, 'ws');
const clipboard = {
  write: (text) => (mac ? execFileSync('pbcopy', { input: text }) : execFileSync('clip.exe', { input: text })),
  read: () => (mac ? execFileSync('pbpaste', { encoding: 'utf8' }) : execFileSync('powershell', ['-c', 'Get-Clipboard'], { encoding: 'utf8' }).trimEnd()),
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

fs.rmSync(userData, { recursive: true, force: true });
for (const dir of [userData, extensions, workspace]) fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({ 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false, 'update.mode': 'none', 'telemetry.telemetryLevel': 'off' }));

const saved = clipboard.read();
const app = await _electron.launch({
  executablePath: code,
  args: [`--extensionDevelopmentPath=${repo}`, `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`, '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--new-window', workspace],
  timeout: 60000,
});
const results = {};
try {
  const window = await app.firstWindow();
  await window.waitForSelector('.monaco-workbench', { timeout: 60000 });
  await sleep(3500);
  await window.keyboard.press(`${mac ? 'Meta' : 'Control'}+Shift+P`);
  await window.keyboard.type('Nodecode: Open Nodecode in an Editor Tab');
  await sleep(900);
  await window.keyboard.press('Enter');

  let page;
  for (let attempt = 0; attempt < 80 && !page; attempt++) {
    page = window.frames().find((frame) => /^http:\/\/127\.0\.0\.1:\d+\/web\//.test(frame.url()));
    if (!page) await sleep(500);
  }
  if (!page) throw new Error('the view never framed the page: is a gateway running in this home?');

  const session = await window.context().newCDPSession(window);
  const modifiers = mac ? 4 : 2;
  const key = async (code_, name) => {
    const base = { modifiers, windowsVirtualKeyCode: code_, nativeVirtualKeyCode: code_, key: name, code: `Key${name.toUpperCase()}` };
    await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };

  const prompt = page.locator('#prompt');
  await prompt.waitFor({ timeout: 30000 });
  results.loaded = await page.evaluate(() => [...document.scripts].some((script) => script.src.endsWith('nodecode-bridge.js')));

  await prompt.click();
  await prompt.fill('');
  clipboard.write('PASTED');
  await key(86, 'v');
  await sleep(800);
  results.paste = (await prompt.inputValue()) === 'PASTED';

  await prompt.fill('COPIED');
  await prompt.click();
  await key(65, 'a');
  clipboard.write('untouched');
  await sleep(300);
  await key(67, 'c');
  await sleep(700);
  results.copy = clipboard.read() === 'COPIED';

  await prompt.fill('CUT');
  await prompt.click();
  await key(65, 'a');
  clipboard.write('untouched');
  await sleep(300);
  await key(88, 'x');
  await sleep(700);
  results.cut = clipboard.read() === 'CUT' && (await prompt.inputValue()) === '';

  clipboard.write('untouched');
  results.pageCopyButton = await page.evaluate(() => navigator.clipboard.writeText('BUTTON').then(() => true, () => false));
  await sleep(500);
  results.pageCopyButton = results.pageCopyButton && clipboard.read() === 'BUTTON';
  await prompt.fill('');
} catch (error) {
  results.error = String((error && error.stack) || error);
} finally {
  clipboard.write(saved);
  console.log(JSON.stringify(results, null, 1));
  await app.close().catch(() => {});
  const failed = Object.entries(results).filter(([name, ok]) => name !== 'error' && ok !== true);
  process.exit(results.error || failed.length ? 1 : 0);
}
