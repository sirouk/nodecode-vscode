import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor(tag, text='') {this.attributes={};this.tagName=tag.toUpperCase();this.children=[];this.style={};this.className='';this._text=text;this.classList={add:()=>{},remove:()=>{}};}
  set textContent(text){this._text=String(text);this.children=[];}
  get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
  appendChild(child){this.children.push(child);return child;}
  append(...children){children.forEach(c=>this.appendChild(c));}
  setAttribute(name,value){this.attributes[name]=String(value);}
  getAttribute(name){return this.attributes[name]??null;}
  addEventListener(){}
  get lastElementChild(){return this.children.at(-1);}
}
const context=vm.createContext({URL,document:{createElement:tag=>new Element(tag),createTextNode:text=>new Element('#text',text)}});
vm.runInContext(readFileSync(new URL('../out/markdown.js',import.meta.url),'utf8'),context);
function render(text){const root=new Element('div');context.NodecodeMarkdown.renderMarkdown(text,root,{external(){},file(){}});return root;}
function all(root,tag){return root.children.flatMap(child=>[...(child.tagName===tag.toUpperCase()?[child]:[]),...all(child,tag)]);}

test('inline renderer formats thoughts without adding block structure or losing blank lines',()=>{
  const root=new Element('div');
  context.NodecodeMarkdown.renderInline('**Reviewing project tasks**\n\nUse `**literal**` and \\*\\*escaped\\*\\*.',root,{external(){},file(){}});
  assert.equal(root.textContent,'Reviewing project tasks\n\nUse **literal** and **escaped**.');
  assert.deepEqual(all(root,'strong').map(n=>n.textContent),['Reviewing project tasks']);
  assert.equal(all(root,'code')[0].textContent,'**literal**');assert.equal(all(root,'p').length,0);
});

test('native fences accept matching long markers, tilde and heading levels',()=>{
  const root=render('````md\n```inside\n````\n\n~~~~{.python}\nx=1\n~~~~\n\n###### Small');
  assert.deepEqual(all(root,'code').map(n=>n.textContent),['```inside','x=1']);
  assert.equal(all(root,'code')[1].className,'language-python');
  assert.equal(all(root,'h6')[0].textContent,'Small');
  assert.equal(all(root,'button')[0].getAttribute('aria-label'),'Copy code');
  assert.equal(all(root,'button')[0].textContent,'');
});

test('fenced code preserves marker, closing length, whitespace and unclosed content',()=>{
  for(const marker of ['`','~'])for(const length of [3,4,6])for(const indent of ['', ' ', '   ', '\t']){
    const other=marker==='`'?'~':'`';
    for(const [closing,closed] of [[marker.repeat(length-1),false],[marker.repeat(length),true],[marker.repeat(length+2),true],[marker.repeat(length)+' extra',false],[other.repeat(length+2),false],[marker.repeat(length)+'\t',true]]){
      const body=' const value = "<literal> & `code`";';
      const markdown=indent+marker.repeat(length)+'{.typescript}\n'+indent+body+'\n'+indent+closing+'\nAfter';
      const root=render(markdown),codes=all(root,'code');
      assert.equal(codes.length,1,JSON.stringify(markdown));
      assert.equal(codes[0].className,'language-typescript');
      assert.equal(codes[0].textContent,closed?body:body+'\n'+closing+'\nAfter',JSON.stringify(markdown));
      assert.deepEqual(all(root,'p').map(node=>node.textContent),closed?['After']:[]);
    }
  }
  const root=render('1. Install:\r\n   ```sh\r\n   echo ready\r\n   ```\r\n\r\nAfter');
  assert.equal(all(root,'ol')[0].textContent,'Install:');
  assert.equal(all(root,'code')[0].textContent,'echo ready');
  assert.equal(all(root,'code')[0].className,'language-sh');
  assert.deepEqual(all(root,'p').map(node=>node.textContent),['After']);
});

test('long fenced code constructs matching and indentation regexes once per fence',()=>{
  let constructions=0;
  const countedContext=vm.createContext({URL,RegExp:new Proxy(RegExp,{construct(target,args){constructions++;return Reflect.construct(target,args);}}),document:{createElement:tag=>new Element(tag),createTextNode:text=>new Element('#text',text)}});
  vm.runInContext(readFileSync(new URL('../out/markdown.js',import.meta.url),'utf8'),countedContext);
  const body=Array.from({length:1500},(_,index)=>'  const row'+index+' = transform(value'+index+');').join('\n');
  const markdown='```typescript\n'+body+'\n```';
  for(let index=0;index<30;index++){
    const root=new Element('div');countedContext.NodecodeMarkdown.renderMarkdown(markdown,root,{external(){},file(){}});
    assert.equal(all(root,'code')[0].textContent,body,'every source line remains available for display and copy');
  }
  assert.equal(constructions,60,'each fence needs two regexes, independent of its line count');
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

test('bare URLs trim only excess trailing parentheses and preserve surrounding punctuation',()=>{
  const urls=['https://example.com/a(b(c))','https://example.com/a(b(c))))','https://example.com/a(b','https://example.com/a)b)','https://example.com/x)).'];
  const root=render(urls.join(' '));
  assert.deepEqual(all(root,'a').map(n=>n.title),['https://example.com/a(b(c))','https://example.com/a(b(c))','https://example.com/a(b','https://example.com/a)b','https://example.com/x']);
  assert.equal(root.textContent,urls.join(' '));
});

test('bare URL cleanup does not recount the entire URL for every trailing parenthesis',()=>{
  const text=('https://example.com/a(b)'+')'.repeat(1900)+' ').repeat(80);
  const root=new Element('div');context.urlRegressionText=text;context.urlRegressionRoot=root;
  try{
    vm.runInContext('NodecodeMarkdown.renderInline(urlRegressionText,urlRegressionRoot,{external(){},file(){}})',context,{timeout:1000});
    assert.equal(root.textContent,text);
    assert.equal(all(root,'a').length,80);
    assert(all(root,'a').every(anchor=>anchor.title==='https://example.com/a(b)'));
  }finally{delete context.urlRegressionText;delete context.urlRegressionRoot;}
});

test('bare prose distinguishes paths from words, dates and fractions',()=>{
  const root=render('and/or on 2026/10/26 and 1/2 with src/panel.ts then `src/components`');
  assert.deepEqual(all(root,'a').map(n=>n.title), ['src/panel.ts','src/components']);
  assert.match(root.textContent,/and\/or on 2026\/10\/26 and 1\/2/);
});

test('bare source paths retain dot and hyphen segments and explicit relative roots',()=>{
  const paths=['src/file-name.test.ts','.config/settings.json','./src/main.ts','../src/panel.ts','/tmp/my-project/.cache/index.ts','-drafts/chapter-one.md','docs.v2/setup-guide.md'];
  const root=render(paths.join(' '));
  assert.deepEqual(all(root,'a').map(n=>n.title),paths);
  assert.equal(root.textContent,paths.join(' '));
});

test('bare path matching does not rescan long path-like tokens',()=>{
  for(const text of ['.'.repeat(80000),'-'.repeat(80000),'.-'.repeat(40000),'a0_'.repeat(26666),'a-/'.repeat(26666),'a/'.repeat(40000),'/'.repeat(80000)]){
    const root=new Element('div');context.pathRegressionText=text;context.pathRegressionRoot=root;
    try{
      vm.runInContext('NodecodeMarkdown.renderInline(pathRegressionText,pathRegressionRoot,{external(){},file(){}})',context,{timeout:1000});
      assert.equal(root.textContent,text);
      assert.equal(all(root,'a').length,0);
    }finally{delete context.pathRegressionText;delete context.pathRegressionRoot;}
  }
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

test('deep blockquotes remain bounded and preserve the remaining source as text',()=>{
  const root=render('> '.repeat(5000)+'deep **content**');
  assert.ok(all(root,'blockquote').length<=64);
  assert.match(root.textContent,/> .*deep \*\*content\*\*$/);
});

test('list nesting follows indentation without manufacturing empty levels',()=>{
  const root=render('- parent\n    - child\n- sibling');
  assert.equal(root.children.length,1);
  const list=root.children[0];
  assert.deepEqual(list.children.map(n=>n.textContent),['parentchild','sibling']);
  const nested=list.children[0].children.find(n=>n.tagName==='UL');
  assert.deepEqual(nested.children.map(n=>n.textContent),['child']);
  assert.equal(all(root,'ul').length,2);
  assert.equal(all(root,'li').length,3);
});

test('list kind changes create adjacent lists at their owning indentation',()=>{
  const root=render('- first\n3. second\n- third\n  4. fourth\n  - fifth\n  6. sixth');
  assert.deepEqual(root.children.map(n=>n.tagName),['UL','OL','UL']);
  assert.equal(root.children[1].start,3);
  assert.deepEqual(root.children.map(n=>n.textContent),['first','second','thirdfourthfifthsixth']);
  const nested=root.children[2].children[0].children.filter(n=>['UL','OL'].includes(n.tagName));
  assert.deepEqual(nested.map(n=>n.tagName),['OL','UL','OL']);
  assert.deepEqual(nested.map(n=>n.textContent),['fourth','fifth','sixth']);
  assert.equal(nested[0].start,4);
  assert.equal(nested[2].start,6);
});

test('dedenting then nesting appends under the current item in source order',()=>{
  const root=render('- first\n  - second\n    - third\n- fourth\n  - fifth');
  assert.equal(root.textContent,'firstsecondthirdfourthfifth');
  const top=root.children[0].children;
  assert.deepEqual(top.map(n=>n.textContent),['firstsecondthird','fourthfifth']);
  assert.equal(all(root,'li').length,5);
  assert.equal(all(top[1],'ul')[0].children[0].textContent,'fifth');
});

test('uneven nested indentation keeps source order when returning to a shallower list',()=>{
  const root=render('- first\n  - second\n      - third\n    - fourth');
  assert.equal(root.textContent,'firstsecondthirdfourth');
  assert.equal(all(root,'li').length,4);
  assert.deepEqual(all(root,'li')[1].children.filter(n=>n.tagName==='UL').map(n=>n.textContent),['third','fourth']);
});


test('ordinary nested quotes retain inline formatting and ordered task lists',()=>{
  const root=render('> **outer**\n> > 7. [x] inner [web](https://example.com)');
  assert.equal(all(root,'blockquote').length,2);
  assert.equal(all(root,'strong')[0].textContent,'outer');
  assert.equal(all(root,'ol')[0].start,7);
  assert.equal(all(root,'input')[0].checked,true);
  assert.equal(all(root,'a')[0].href,'https://example.com/');
});
