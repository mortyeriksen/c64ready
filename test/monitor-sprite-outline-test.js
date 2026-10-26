import assert from 'node:assert/strict';
import { traceSpriteOutlines } from '../src/monitor/sprite-outline.js';

function trace(width,height,owners,border=new Uint8Array(owners.length)) {
  const paths=Array.from({length:8},()=>({edges:[],point:null,moveTo(x,y){this.point=[x,y];},lineTo(x,y){this.edges.push([...this.point,x,y]);}}));
  traceSpriteOutlines({width,height,owners:Uint8Array.from(owners),border},paths);
  return paths.map(path=>path.edges);
}
let edges=trace(2,1,[0,0]);
assert.equal(edges[0].length,6,'adjacent pixels of one sprite have no interior outline edge');
assert.ok(!edges[0].some(([x,,endX])=>x===1&&endX===1),'shared pixel boundary inside one sprite is omitted');
edges=trace(2,1,[0,1]);
assert.equal(edges[0].length,4,'touching slots retain the first sprite boundary');
assert.equal(edges[1].length,4,'touching slots retain the second sprite boundary');
edges=trace(3,1,[0,255,0]);
assert.equal(edges[0].length,8,'separate appearances of one slot remain separate outlines');
assert.ok(edges[0].every(([x,y,endX,endY])=>Math.abs(x-endX)+Math.abs(y-endY)===1),'outline never bridges empty pixels between reused sprites');
edges=trace(2,1,[0,0],Uint8Array.of(0,1));
assert.deepEqual(edges[0],[[0,0,1,0],[1,0,1,1],[1,1,0,1],[0,1,0,0]],'border masking closes coverage at the actual unmasked edge');
edges=trace(2,2,[255,0,0,255]);
assert.equal(edges[0].length,8,'last column never joins the first column of the next row');
assert.equal(trace(1,1,[255]).flat().length,0,'background pixels produce no sprite outline');
console.log('ok  - sprite coverage contours, neighbouring slots, reuse, image edges and border masking');
