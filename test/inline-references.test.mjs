import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {INLINE_REFERENCE_JS}=require('../out/inline-references.js');
function setup(text,refs){const c=vm.createContext({composer:{value:text},referenceText:text,referenceEdit:null,inlineRefs:refs,files:[]});vm.runInContext(INLINE_REFERENCE_JS,c);c.reconcileInlineReferences();return c;}
const paths=c=>Array.from(c.files);
test('inline accepted references shift with surrounding edits and disappear when their text is edited',()=>{
 const text='Use @docs/My File.md now';const c=setup(text,[{path:'docs/My File.md',start:4,end:20}]);
 assert.deepEqual(paths(c),['docs/My File.md']);
 c.composer.value='Please '+text;c.reconcileInlineReferences();assert.equal(c.inlineRefs[0].start,11);assert.deepEqual(paths(c),['docs/My File.md']);
 c.composer.value=c.composer.value.replace('My File','Your File');c.reconcileInlineReferences();assert.deepEqual(paths(c),[]);
});
test('unselected literal references never attach and deleting a selected span cannot reattach its later copy',()=>{
 const text='@a.ts and @a.ts';const c=setup(text,[{path:'a.ts',start:0,end:5}]);
 c.composer.value=' and @a.ts';c.reconcileInlineReferences();assert.deepEqual(paths(c),[]);
 c.composer.value='@a.ts';c.reconcileInlineReferences();assert.deepEqual(paths(c),[]);
});
test('persisted ranges validate exact token boundaries on restoration',()=>{
 const c=setup('Use @a.tsx then @docs/My File.md',[{path:'a.ts',start:4,end:9},{path:'docs/My File.md',start:16,end:32}]);
 assert.deepEqual(paths(c),['docs/My File.md']);
});

test('actual edit range prevents deleted approval transferring to an identical literal token',()=>{
 const text='@a.ts and @a.ts';const c=setup(text,[{path:'a.ts',start:0,end:5}]);
 c.referenceEdit={text,start:0,end:10,type:'deleteContentBackward'};c.composer.value='@a.ts';c.composer.selectionStart=0;c.reconcileInlineReferences();assert.deepEqual(paths(c),[]);
 const fallback=setup(text,[{path:'a.ts',start:0,end:5}]);fallback.composer.value='@a.ts';fallback.reconcileInlineReferences();assert.deepEqual(paths(fallback),[]);
});
