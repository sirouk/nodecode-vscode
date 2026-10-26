import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { matchRuntimeRelease } = require('../out/runtime-metadata.js');
const base='https://github.com/nodecode-ai/nodecode/releases';

test('runtime release links only exact published version or build tags',()=>{
  const published_at='2026-10-25T12:00:00Z';
  assert.deepEqual(matchRuntimeRelease('nodecode 0.0.1+c6418bcbe',[
    {tag_name:'v0.0.1',html_url:base+'/tag/v0.0.1',published_at},
    {tag_name:'c6418bcbe',html_url:base+'/tag/c6418bcbe',published_at},
  ]),{releaseUrl:base+'/tag/c6418bcbe',releaseTag:'c6418bcbe',releasePublishedAt:published_at});
  assert.equal(matchRuntimeRelease('nodecode 1.2.3',[{tag_name:'v1.2.3',html_url:base+'/tag/v1.2.3'}]).releaseTag,'v1.2.3');
});

test('missing, draft, foreign and unrelated releases never invent a release or date',()=>{
  for(const rows of [[],[{tag_name:'newest',html_url:base+'/tag/newest'}],[{tag_name:'v1.2.3',html_url:base+'/tag/v1.2.3',draft:true}],[{tag_name:'v1.2.3',html_url:'https://example.com/release'}]]){
    assert.deepEqual(matchRuntimeRelease('1.2.3',rows),{releaseUrl:base});
  }
});
