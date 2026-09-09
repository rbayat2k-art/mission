import assert from 'node:assert/strict';
import test from 'node:test';
import {workflowHarness} from './helpers/workflow-harness.mjs';

test('manager and employee exchange messages and attachments linked to the returned message ID',async()=>{
  const h=await workflowHarness();
  for(const user of ['admin','supervisor-a','employee-a']){
    const response=await h.send(user,'request-a',{text:`fixture reply ${user}`});
    assert.equal(response.status,201);
    const {message}=await response.json();
    assert.notEqual(message.id,'request-a');
    assert.ok(h.messages.has(message.id));
    const uploaded=await h.upload(user,'mission-a',message.id);
    assert.equal(uploaded.status,201);
    const {attachment}=await uploaded.json();
    assert.equal((await h.download('employee-a',attachment.id)).status,200);
    assert.equal((await h.download('employee-b',attachment.id)).status,403);
    assert.equal((await h.download('supervisor-b',attachment.id)).status,403);
  }
  assert.equal(h.requests.get('request-a').status,'awaiting_supervisor');
  assert.equal(h.messages.size,3);assert.equal(h.attachments.size,3);
  assert.deepEqual(h.notifications.map(item=>item.userId),['employee-a','employee-a','supervisor-a']);
});
test('20 concurrent retries with one event ID create one message, audit and notification',async()=>{
  const h=await workflowHarness();
  const body={text:'fixture',clientMessageId:crypto.randomUUID()};
  const replies=await Promise.all(Array.from({length:20},()=>h.send('employee-a','request-a',body)));
  assert.equal(replies.filter(item=>item.status===201).length,1);
  assert.equal(replies.filter(item=>item.status===200).length,19);
  assert.equal(h.messages.size,1);assert.equal(h.audits.length,1);assert.equal(h.notifications.length,1);
});
test('reused ID cannot overwrite a report or cross accounts, and closed threads reject new messages',async()=>{
  const h=await workflowHarness();const body={text:'fixture',clientMessageId:crypto.randomUUID()};
  assert.equal((await h.send('employee-a','request-a',body)).status,201);
  assert.equal((await h.send('employee-a','request-a',{...body,text:'changed'})).status,409);
  assert.equal((await h.send('employee-b','request-a',body)).status,403);
  assert.equal((await h.send('supervisor-b','request-a',body)).status,403);
  h.requests.get('request-a').status='resolved';
  assert.equal((await h.send('employee-a','request-a',body)).status,200);
  assert.equal((await h.send('employee-a','request-a',{text:'new'})).status,409);
  assert.equal(h.messages.size,1);
});
test('the current escalated manager receives the employee reply, not the previous supervisor',async()=>{
  const h=await workflowHarness();Object.assign(h.requests.get('request-a'),{status:'escalated',assignedTo:'admin'});
  assert.equal((await h.send('employee-a','request-a',{text:'fixture'})).status,201);
  assert.equal(h.notifications[0].userId,'admin');
});
test('malformed messages and an account change fail before any mutation',async()=>{
  const h=await workflowHarness();
  for(const body of [null,[],{text:5},{text:{}},{text:'a',clientMessageId:'invalid'},{text:'x'.repeat(4001)}])assert.equal((await h.send('employee-a','request-a',body)).status,400);
  assert.equal((await h.send('employee-b','request-a',{text:'fixture'},{'X-Tapra-User-Id':'employee-a'})).status,409);
  assert.equal(h.messages.size,0);assert.equal(h.notifications.length,0);
});
