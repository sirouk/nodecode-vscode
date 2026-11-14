// The rule this extension lives under on the Marketplace: it is immutable. Its
// code is the package and nothing else -- no installer, no code fetched from a
// repository or a CDN, no update step. This test is the tripwire for that rule,
// so a later change that reintroduces a download fails here rather than in a
// review three days before a delisting.

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';

const root=new URL('..',import.meta.url);
const read=(name)=>readFile(new URL(name,root),'utf8');

const DOWNLOAD=/\bcurl\b|\bwget\b|install\.sh|install\.ps1|nc:\/\//;

test('no source file runs or names a downloader',async()=>{
  const files=(await readdir(new URL('src',root))).filter((name)=>name.endsWith('.ts'));
  assert.ok(files.length>5,'the sources are where they are expected');
  for(const name of files){
    assert.doesNotMatch(await read(`src/${name}`),DOWNLOAD,`src/${name} must not fetch or install anything`);
  }
});

test('the built output carries no downloader either',async()=>{
  for(const name of (await readdir(new URL('out',root))).filter((entry)=>entry.endsWith('.js'))){
    assert.doesNotMatch(await read(`out/${name}`),DOWNLOAD,`out/${name} must not fetch or install anything`);
  }
});

test('the manifest offers no command that installs or updates nodecode',async()=>{
  const manifest=JSON.parse(await read('package.json'));
  const commands=manifest.contributes.commands.map((entry)=>entry.command);
  assert.deepEqual(commands.filter((id)=>/install|update|download/.test(id)),[],'a command the policy forbids is a command nobody publishes');
  assert.doesNotMatch(JSON.stringify(manifest),DOWNLOAD,'and no install address rides in the manifest');
});

test('the code that ships beside the extension is its own cell, and only that',async()=>{
  const shipped=await readdir(new URL('resources',root));
  assert.deepEqual(shipped,['remote'],'the remote-access cell travels in the package; nothing else does');
  assert.match(await read('resources/remote/nodecode-web-remote.asd'),/defsystem "nodecode-web-remote"/);
});
