import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {DIFF_CLIENT_JS,DIFF_CSS}=require('../out/diff-view.js');
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const context=vm.createContext({esc});vm.runInContext(DIFF_CLIENT_JS,context);
const parse=patch=>JSON.parse(JSON.stringify(context.parseUnifiedDiff(patch)));

 test('unified patches retain exact lines and number both sides across hunks',()=>{
  const patch='diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -2,3 +2,4 @@ function run()\n keep\n-old\n+new\n+\n tail\n@@ -10 +11 @@\n--- looks like a header\n+++ also source\n\\ No newline at end of file\n';
  const result=parse(patch);
  assert.equal(result.incomplete,false);assert.equal(result.unrecognized,false);
  assert.deepEqual(result.rows.filter(r=>r.old!==undefined||r.next!==undefined),[
    {text:' keep',kind:'context',old:2,next:2},{text:'-old',kind:'remove',old:3},
    {text:'+new',kind:'add',next:3},{text:'+',kind:'add',next:4},{text:' tail',kind:'context',old:4,next:5},
    {text:'--- looks like a header',kind:'remove',old:10},{text:'+++ also source',kind:'add',next:11},
  ]);
  assert.equal(result.rows.at(-1).text,'\\ No newline at end of file');
 });

 test('new and deleted files do not manufacture a blank line on the empty side',()=>{
  assert.deepEqual(parse('@@ -0,0 +1,2 @@\n+first\n+second').rows.slice(1),[{text:'+first',kind:'add',next:1},{text:'+second',kind:'add',next:2}]);
  assert.deepEqual(parse('@@ -1,2 +0,0 @@\n-first\n-second').rows.slice(1),[{text:'-first',kind:'remove',old:1},{text:'-second',kind:'remove',old:2}]);
  assert.equal(parse('@@ -0,0 +1,0 @@').incomplete,false);
  assert.equal(parse('@@ -0 +1 @@\n-x\n+y').incomplete,true);
 });

 test('CRLF, context-only and mode-only patches remain inspectable without false changes',()=>{
  assert.deepEqual(parse('@@ -3 +8 @@\r\n same\r\n').rows,[{text:'@@ -3 +8 @@',kind:'hunk'},{text:' same',kind:'context',old:3,next:8}]);
  assert.deepEqual(parse('old mode 100644\nnew mode 100755').rows.map(r=>r.kind),['meta','meta']);
  assert.equal(parse('old mode 100644\nnew mode 100755').incomplete,false);
 });

 test('incomplete, malformed and overflowing hunks never invent following line numbers',()=>{
  for(const patch of ['@@ -1,2 +1,2 @@\n-a\n+b','@@ -1 +1 @@\nnot a prefixed line\n+other','@@ bad @@\n+a','@@ -9007199254740991,2 +1,2 @@\n-a\n+b']){
    const result=parse(patch);assert.equal(result.incomplete,true,patch);
    assert(result.rows.every(row=>!['raw','meta'].includes(row.kind)||(row.old===undefined&&row.next===undefined)));
    assert(context.diffParseNotice(context.parseUnifiedDiff(patch)).includes('incomplete or malformed'));
  }
  assert.equal(parse('@@ -1 +1 @@\n-a\n+b\n+extra').rows.at(-1).kind,'raw');
  assert.equal(parse('some unstructured output\n+code').unrecognized,true);
 });

 test('file normalization rejects malformed records and keeps unknown counts distinct from zero',()=>{
  const files=JSON.parse(JSON.stringify(context.diffFiles({truncated:true,files:[null,[],{},'x',{path:0},{path:''},{path:'a',added:-1,removed:1.5},{path:'b',added:0,removed:2,binary:'true',patch:4},{path:'c',added:Number.MAX_SAFE_INTEGER+1,binary:true}]})));
  assert.deepEqual(files,[{path:'a',binary:false,truncated:true},{path:'b',added:0,removed:2,binary:false,truncated:true},{path:'c',binary:true,truncated:true}]);
  assert(context.diffCountsHtml(files[0]).includes('+?'));assert(context.diffCountsHtml(files[1]).includes('+0'));
  assert.equal(context.diffCountsHtml(files[2]),'<span class="diff-badge">binary</span>');
  assert(context.diffTotalsHtml([{added:1,removed:0},{removed:2}]).includes('+?'));
 });

 test('safe diff markup separates file navigation from the disclosure and escapes code and paths',()=>{
  const path='src/<img src=x onerror="evil()">.ts',patch='@@ -1 +1 @@\n-<script>evil()</script>\n+<b>& new</b>';
  const shell=context.diffFileHtml({path,added:1,removed:1,patch},'a"<&','tool-diff','Latest recorded change');
  const html=shell+context.diffLinesHtml(context.parseUnifiedDiff(patch));
  assert(!html.includes('<script>'));assert(!html.includes('<img '));assert(html.includes('&lt;script&gt;'));
  assert(html.includes('data-diff-key="a&quot;&lt;&amp;"'));assert(!/<summary[^>]*>[\s\S]*?<button[\s\S]*?<\/summary>/.test(html));
  assert(html.includes('</details><button class="diff-open"'));assert(html.includes('aria-expanded="false"'));
  assert(html.includes('aria-label="Open file src/&lt;img'));
  assert(html.includes('diff-remove'));assert(html.includes('diff-add'));assert(html.includes('data-old="1"'));assert(html.includes('data-new="1"'));
  assert(!html.includes('data-old="0"'));assert(DIFF_CSS.includes('--vscode-diffEditor-insertedLineBackground'));
 });

 test('binary, missing and explicitly truncated patches have honest visible states',()=>{
  assert(context.diffPatchHtml({path:'binary',binary:true},'a').includes('Binary file changed'));
  assert(context.diffPatchHtml({path:'missing'},'a').includes('No textual patch was recorded'));
  assert(context.diffPatchHtml({path:'partial',truncated:true},'a').includes('marked this recorded change as truncated'));
  const empty=context.diffLinesHtml(context.parseUnifiedDiff('@@ -0,0 +1 @@\n+'));
  assert(empty.includes('data-new="1"'));assert(empty.includes('class="diff-marker">+</span>'));
 });

 test('collapsed patch markup stays small without discarding recorded lines',()=>{
  const patch='@@ -0,0 +1,10000 @@\n'+Array.from({length:10000},(_,i)=>'+line '+i).join('\n');
  const html=context.diffFileHtml({path:'large.ts',patch},'large','activity-file','');
  assert(html.includes('data-diff-pending'));assert(!html.includes('class="diff-line'));
  assert(html.includes('+line 9999'));assert(html.length<patch.length+1500);
 });

 test('Git suppressed blank context retains numbering and the original blank patch line',()=>{
  const patch='@@ -1,4 +1,4 @@\n first\n\n-old\n+new\n last';
  const result=parse(patch);assert.equal(result.incomplete,false);assert.equal(result.unrecognized,false);
  assert.deepEqual(result.rows[2],{text:'',kind:'context',old:2,next:2});
  assert.deepEqual(result.rows[3],{text:'-old',kind:'remove',old:3});
  assert.deepEqual(result.rows[4],{text:'+new',kind:'add',next:3});
 });
