import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadTypescript } from "./helpers/load-typescript.mjs";
const policy = await loadTypescript(new URL("../lib/password-policy.ts", import.meta.url));

test("four-character passwords need no character classes; long passwords remain valid", () => {
  for (const value of ["1234", "abcd", "a1b2", "سلام", "۱۲۳۴", "!!!!", "Existing-Long-Password1"]) assert.equal(policy.isValidPassword(value), true);
  for (const value of ["", "123", "abc", null, undefined, 1234, {}]) assert.equal(policy.isValidPassword(value), false);
});

test("real change-password route accepts simple passwords and preserves confirmation/session rotation", async () => {
  let writes=0, hashed=null;
  const route=await loadTypescript(new URL("../app/api/auth/change-password/route.ts", import.meta.url), {
    "../../../../lib/password-policy":policy,
    "../../../../lib/auth":{getSessionUser:async()=>({id:"fixture"}),isSecureRequest:()=>true,sessionCookie:()=>"fixture",rotateSession:async()=>{writes++;return {token:"fixture",expires:0}}},
    "../../../../lib/security":{hashPassword:async value=>{hashed=value;return {hash:"fixture",salt:"fixture"}}},
    "../../../../db/runtime":{ensureDatabase:async()=>({prepare:()=>({bind:()=>({})})})},
  });
  const send=body=>route.POST(new Request("https://example.test/api/auth/change-password",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}));
  for (const value of ["1234","abcd","سلام","a1b2"]) {assert.equal((await send({newPassword:value,confirmPassword:value})).status,200);assert.equal(hashed,value);}
  assert.equal(writes,4);
  assert.equal((await send({newPassword:"123"})).status,400);
  assert.equal((await send({newPassword:"1234",confirmPassword:"4321"})).status,400);
  assert.equal((await send({newPassword:1234})).status,400);
  assert.equal(writes,4);
  assert.equal((await send({newPassword:"abcd"})).status,200); // Cached Android client without confirmation.
});

test("all password-setting routes share policy; login throttling and hashing remain present", async () => {
  for (const path of ["auth/change-password","account","admin/users","admin/users/[id]"]) {
    const source=await readFile(new URL(`../app/api/${path}/route.ts`,import.meta.url),"utf8");
    assert.match(source,/isValidPassword\(/);
    assert.doesNotMatch(source,/password\.length < (8|10)|newPassword\.length < 10/);
  }
  const login=await readFile(new URL("../app/api/auth/login/route.ts",import.meta.url),"utf8");
  assert.match(login,/loginRateLimit/); assert.match(login,/status:429/);
  const security=await readFile(new URL("../lib/security.ts",import.meta.url),"utf8");
  assert.match(security,/iterations: 210_000/);
});
