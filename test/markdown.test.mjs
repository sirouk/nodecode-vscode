import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor(tag, text='') {this.tagName=tag.toUpperCase();this.children=[];this.style={};this.className='';this._text=text;this.classList={add:()=>{},remove:()=>{}};}
  set textContent(text){this._text=String(text);this.children=[];}
  get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
  appendChild(child){this.children.push(child);return child;}
  append(...children){children.forEach(c=>this.appendChild(c));}
  addEventListener(){}
  get lastElementChild(){return this.children.at(-1);}
}
const context=vm.createContext({URL,document:{createElement:tag=>new Element(tag),createTextNode:text=>new Element('#text',text)}});
vm.runInContext(readFileSync(new URL('../out/markdown.js',import.meta.url),'utf8'),context);
function render(text){const root=new Element('div');context.NodecodeMarkdown.renderMarkdown(text,root,{external(){},file(){}});return root;}
function all(root,tag){return root.children.flatMap(child=>[...(child.tagName===tag.toUpperCase()?[child]:[]),...all(child,tag)]);}

test('native fences accept matching long markers, tilde and heading levels',()=>{
  const root=render('````md\n```inside\n````\n\n~~~~{.python}\nx=1\n~~~~\n\n###### Small');
  assert.deepEqual(all(root,'code').map(n=>n.textContent),['```inside','x=1']);
  assert.equal(all(root,'code')[1].className,'language-python');
  assert.equal(all(root,'h6')[0].textContent,'Small');
});

test('native table splitting keeps code and escaped pipes and column alignment',()=>{
  const root=render('A | B\n--- | :---:\n`a|b` | c\\|d');
  assert.equal(all(root,'table').length,1);
  assert.deepEqual(all(root,'td').map(n=>n.textContent),['a|b','c|d']);
  assert.equal(all(root,'td')[1].style.textAlign,'center');
});

test('native inline syntax preserves escapes, tasks, emphasis, strike, safe color and links',()=>{
  const root=render('\\*literal\\* ***both*** ~~gone~~ <span style="color:#FF8800">warm</span> https://example.com.\n\n- [x] done\n- [ ] todo');
  assert.match(root.textContent,/\*literal\*/);
  assert.equal(all(root,'strong')[0].textContent,'both');
  assert.equal(all(root,'em')[0].textContent,'both');
  assert.equal(all(root,'s')[0].textContent,'gone');
  assert.equal(all(root,'span').find(n=>n.style.color)?.textContent,'warm');
  assert.equal(all(root,'a')[0].href,'https://example.com/');
  assert.deepEqual(all(root,'input').map(n=>[n.checked,n.disabled]),[[true,true],[false,true]]);
});

test('agent HTML and unsafe URL schemes stay inert text',()=>{
  const root=render('<script>alert(1)</script> [x](javascript:alert) <span onclick="run()">bad</span>');
  assert.equal(all(root,'script').length,0);
  assert.equal(all(root,'span').length,0);
  assert.match(root.textContent,/<script>/);
  assert.equal(all(root,'a')[0].href,'#');
});

test('native table edges keep escaped trailing pipe and unmatched code tick',()=>{
  assert.deepEqual(all(render('| A | B |\n|---|---|\n| x | y\\|'),'td').map(n=>n.textContent),['x','y|']);
  assert.deepEqual(all(render('| A | B |\n|---|---|\n| `x | y |'),'td').map(n=>n.textContent),['`x','y']);
  const root=render('## Heading ##\n\n* * *');
  assert.equal(all(root,'h2')[0].textContent,'Heading');
  assert.equal(all(root,'hr').length,1);
});

test('quoted URLs stop at quotation marks and safe source paths link from prose or code',()=>{
  const root=render('"https://example.com" (https://example.com/a(b)). `src/store.ts:42` and src/panel.ts:10');
  assert.deepEqual(all(root,'a').map(n=>n.href), ['https://example.com/','https://example.com/a(b)','#','#']);
  assert.equal(all(root,'a')[2].title,'src/store.ts:42');
  assert.equal(all(root,'code')[0].textContent,'src/store.ts:42');
  assert.equal(all(render('`console.log(1)`'),'a').length,0);
});

test('bare prose distinguishes paths from words, dates and fractions',()=>{
  const root=render('and/or on 2026/10/26 and 1/2 with src/panel.ts then `src/components`');
  assert.deepEqual(all(root,'a').map(n=>n.title), ['src/panel.ts','src/components']);
  assert.match(root.textContent,/and\/or on 2026\/10\/26 and 1\/2/);
});

test('explicit angle-wrapped destinations preserve spaces and reject unsafe schemes',()=>{
  const root=render('[report](<docs/My Report.md>) [web](<https://example.com/a b>) [bad](<javascript:alert>)');
  const anchors=all(root,'a');
  assert.equal(anchors[0].title,'docs/My Report.md');
  assert.equal(anchors[0].href,'#');
  assert.equal(anchors[1].href,'https://example.com/a%20b');
  assert.equal(anchors[2].className,'md-link-inert');
  const parsed=context.NodecodeMarkdown.parseFileLink('<docs/My Report.md#L10>');
  assert.equal(parsed.path,'docs/My Report.md');
  assert.equal(parsed.startLine,10);
});
