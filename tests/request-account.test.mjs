import assert from "node:assert/strict";
import test from "node:test";
import { loadTypescript } from "./helpers/load-typescript.mjs";

async function authFor(sessionUser) {
  let lookups = 0;
  const auth = await loadTypescript(new URL("../lib/auth.ts", import.meta.url), {
    "../db/runtime": { ensureDatabase: async () => ({ prepare: () => ({ bind: () => ({ first: async () => { lookups++; return sessionUser; } }) }) }) },
    "./security": { hashToken: async () => "test-hash" },
  });
  return { ...auth, lookups: () => lookups };
}
const user = { id:"account-b", role:"employee", mustChangePassword:0, notificationEnabled:1 };
const request = (expected, cookie="rahkar_session=test-session") => new Request("http://localhost/api/work-sessions", {
  method:"POST", headers:{ cookie, ...(expected === undefined ? {} : { "X-Tapra-User-Id":expected }) },
});

test("a stale tab cannot submit account A's operation using account B's session", async () => {
  const auth = await authFor(user);
  const result = await auth.requireRole(request("account-a"), ["employee"]);
  assert.equal(result.error?.status, 409);
  assert.equal((await result.error.json()).code, "ACCOUNT_CONTEXT_CHANGED");
  assert.match(result.error.headers.get("cache-control"), /no-store/);
  assert.equal(result.user, undefined);
});

test("account binding allows the matching account and legacy clients without a header", async () => {
  const auth = await authFor(user);
  for (const expected of ["account-b", undefined]) {
    assert.equal((await auth.requireRole(request(expected), ["employee"])).user.id, user.id);
  }
  assert.equal((await auth.requireRole(request("account-b"), ["admin"])).error.status, 403);
});

test("an expected-account header never authenticates an unauthenticated request", async () => {
  const auth = await authFor(null);
  assert.equal((await auth.requireRole(request("account-b", ""), ["employee"])).error.status, 401);
  assert.equal(auth.lookups(), 0);
});

test("a malformed session cookie is unauthenticated, not an unhandled URI error", async () => {
  const auth = await authFor(user);
  assert.equal((await auth.requireRole(request(undefined,"rahkar_session=%E0%A4%A"),["employee"])).error.status,401);
  assert.equal(auth.lookups(),0);
});

test("malformed login JSON is rejected before database access or password hashing", async () => {
  const never = () => { throw new Error("Unexpected access for malformed input"); };
  const login = await loadTypescript(new URL("../app/api/auth/login/route.ts",import.meta.url),{
    "../../../../db/runtime":{ensureDatabase:never},
    "../../../../lib/auth":{},
    "../../../../lib/login-rate-limit":{},
    "../../../../lib/security":{hashPassword:never,verifyPassword:never},
  });
  for (const body of [null,[],17,{username:42,password:"test"},{username:"test",password:{}},{username:"test",password:[]},{username:false,password:"test"}]) {
    const response=await login.POST(new Request("http://localhost/api/auth/login",{
      method:"POST", headers:{"Content-Type":"application/json"},body:JSON.stringify(body),
    }));
    assert.equal(response.status,400);
  }
});
