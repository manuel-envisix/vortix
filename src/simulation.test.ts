import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delivery, deliveryStatus, simulation } from './simulation';
for(const count of [1,5,20,60,100])test(`${count} agents remain consistent through 400 simulation ticks`,()=>{
 let state=simulation.create(count);assert.equal(state.agents.length,count);
 for(let tick=0;tick<400;tick++){
  state=simulation.advance(state);assert.ok(state.events.length<=60);
  const ids=new Set(state.agents.map(a=>a.id));assert.equal(ids.size,count);
  for(const a of state.agents){assert.ok(a.task.progress!==null);assert.ok(a.task.progress>=0&&a.task.progress<=100);if(a.parentId)assert.ok(ids.has(a.parentId));assert.equal(a.status==='complete',a.task.progress===100);const {pr,pipeline}=delivery(a);assert.equal(pr.state==='merged',a.status==='complete');if(a.status==='complete')assert.ok(pipeline.stages.every(s=>s.state==='passed'));}
  for(const e of state.events)assert.ok(ids.has(e.agentId));
 }
});
test('simulation resets and replay are deterministic',()=>{let a=simulation.create(20),b=simulation.create(20);for(let i=0;i<50;i++){a=simulation.advance(a);b=simulation.advance(b);}assert.deepEqual(a,b);assert.deepEqual(simulation.create(20),simulation.create(20));});
test('world status badges agree with inspector delivery stages',()=>{
 const a=simulation.create(1).agents[0];
 for(const progress of [0,24,25,40,41,50,75,99,100]){
  const agent={...a,task:{...a.task,progress}};
  const detail=delivery(agent),badge=deliveryStatus(agent);
  assert.equal(badge.pr,detail.pr.state);
  assert.equal(badge.ci,progress===100?'passed':'running');
  assert.equal(badge.pr,progress===100?'merged':progress>40?'open':'draft');
 }
});
