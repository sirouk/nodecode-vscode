import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {formatContextCount}=require('../out/model-controls.js');
test('context counts use consistent uppercase units with threshold promotion',()=>{
 for(const [value,label] of [[0,'0'],[999,'999'],[1000,'1 K'],[2300,'2.3 K'],[32000,'32 K'],[999949,'999.9 K'],[999950,'1 M'],[1000000,'1 M'],[1050000,'1.1 M']])assert.equal(formatContextCount(value),label);
});
