import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeJalaliDeadline} from '../lib/mission-deadline.ts';
import {normalizeMissionTasks} from '../lib/mission-tasks.ts';
import {loadTypescript} from './helpers/load-typescript.mjs';

test('non-leap Esfand 30 is rejected, leap Esfand 30 and Persian digits are valid',()=>{
  assert.ok('error' in normalizeJalaliDeadline('1404/12/30','14:30'));
  assert.ok('deadlineAt' in normalizeJalaliDeadline('۱۴۰۳/۱۲/۳۰','۱۴:۳۰'));
  for(const value of [4,{},[],false])assert.ok('error' in normalizeJalaliDeadline(value,'14:30'));
});
test('malformed mission/task/step fields return validation errors without throwing or opening a database',async()=>{
  const steps=await loadTypescript(new URL('../lib/mission-steps.ts',import.meta.url),{'./mission-deadline':{normalizeJalaliDeadline}});
  const {POST}=await loadTypescript(new URL('../app/api/missions/route.ts',import.meta.url),{
    '../../../db/runtime':{ensureDatabase:()=>{throw new Error('Database must not open for malformed input');}},
    '../../../lib/auth':{requireRole:async()=>({user:{id:'admin',role:'admin'}})},
    '../../../lib/mission-deadline':{normalizeJalaliDeadline},'../../../lib/push-notifications':{},'../../../lib/mission-status-events':{},'../../../lib/mission-steps':steps,'../../../lib/mission-tasks':{normalizeMissionTasks},'../../../lib/mission-execution-rank':{},
  });
  for(const body of [null,[],{title:42},{title:'valid',description:{}},{title:'valid',assignedTo:[]},{title:'x'.repeat(256)}])assert.equal((await POST(new Request('http://fixture/api/missions',{method:'POST',body:JSON.stringify(body)}))).status,400);
  for(const value of [42,{},[],true]){
    assert.ok('error' in normalizeMissionTasks([{title:value},{title:'valid'}]));
    assert.ok('error' in steps.normalizeMissionSteps([{title:'valid',description:value},{title:'valid'}]));
  }
});
