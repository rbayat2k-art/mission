import assert from "node:assert/strict";
import test from "node:test";
import { loadTypescript } from "./helpers/load-typescript.mjs";

const policy = await loadTypescript(new URL("../lib/mission-location.ts", import.meta.url));
const gps = await loadTypescript(new URL("../lib/gps-acquisition.ts", import.meta.url), { "./mission-location": policy });
const response = await loadTypescript(new URL("../lib/work-start-deadline.ts", import.meta.url));
const point = (accuracy = 49, age = 0) => ({ coords: { latitude: 35.7, longitude: 51.4, accuracy }, timestamp: Date.now() - age });
function setup(t, extra = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const callbacks = {}; const cleared = []; const progress = []; const diagnostics = [];
  const geolocation = { watchPosition: (success, error) => { callbacks.success = success; callbacks.error = error; return 0; }, clearWatch: id => cleared.push(id) };
  const operation = gps.createGpsAcquisition({ geolocation, secureContext: true, protocol: "https:", onProgress: p => progress.push(p), onDiagnostic: e => diagnostics.push(e), ...extra });
  const result = operation.promise.then(location => ({ location }), error => ({ reason: error.reason }));
  return { operation, result, callbacks, cleared, progress, diagnostics };
}
for (const accuracy of [49, 100]) test(`fresh ${accuracy}m settles READY and clears watch id zero`, async t => {
  const h = setup(t); h.callbacks.success(point(accuracy));
  assert.equal((await h.result).location.accuracy, accuracy);
  assert.deepEqual(h.cleared, [0]); assert.equal(h.progress.at(-1).phase, "READY");
});
test("101m fails within deadline; no trusted fix is returned", async t => {
  const h = setup(t); h.callbacks.success(point(101));
  assert.equal(h.progress.at(-1).phase, "WAITING_ACCURACY");
  t.mock.timers.tick(25_000); assert.equal((await h.result).reason, "LOW_ACCURACY"); assert.deepEqual(h.cleared, [0]);
});
test("stale 49m remains waiting then a fresh fix succeeds", async t => {
  const h = setup(t); h.callbacks.success(point(49, 180_000));
  assert.equal(h.progress.at(-1).phase, "WAITING_FRESH"); h.callbacks.success(point());
  assert.ok((await h.result).location);
});
test("stale fix without improvement ends STALE", async t => {
  const h = setup(t); h.callbacks.success(point(49, 180_000)); t.mock.timers.tick(25_000);
  assert.equal((await h.result).reason, "STALE");
});
test("poor accuracy updates show current accuracy and can improve", async t => {
  const h = setup(t); h.callbacks.success(point(250)); h.callbacks.success(point(300));
  assert.equal(h.progress.at(-1).accuracy, 300); h.callbacks.success(point(99));
  assert.ok((await h.result).location);
});
for (const [code, reason] of [[1,"PERMISSION_DENIED"],[2,"POSITION_UNAVAILABLE"],[3,"TIMEOUT"],[7,"UNKNOWN_ERROR"]]) {
  test(`browser error ${code} settles immediately as ${reason}`, async t => {
    const h = setup(t); h.callbacks.error({ code, message: "DO NOT LOG raw provider text" });
    assert.equal((await h.result).reason, reason); assert.deepEqual(h.cleared, [0]);
    assert.ok(!JSON.stringify(h.diagnostics).includes("DO NOT LOG"));
  });
}
test("H: neither callback occurs; independent deadline settles, late success/error ignored, retry succeeds", async t => {
  const h = setup(t); t.mock.timers.tick(25_000);
  assert.equal((await h.result).reason, "TIMEOUT"); assert.equal(h.diagnostics.at(-1).callback, "none");
  const count = h.progress.length; h.callbacks.success(point()); h.callbacks.error({code:1});
  assert.equal(h.progress.length, count); assert.deepEqual(h.cleared, [0]);
  const retry = gps.createGpsAcquisition({ geolocation: { watchPosition(success) { success(point()); return 9; }, clearWatch() {} }, secureContext:true, protocol:"https:" });
  assert.ok(await retry.promise);
});
for (const reason of ["PERMISSION_DENIED", "PRECISE_REQUIRED", "LOCATION_DISABLED"]) {
  test(`native preflight ${reason} fails before watching`, async t => {
    const h = setup(t, { bridge: { isNativeApp:()=>true, isLocationPermissionGranted:()=>reason!=="PERMISSION_DENIED", isPreciseLocationPermissionGranted:()=>reason!=="PRECISE_REQUIRED", getLocationServiceState:()=>reason==="LOCATION_DISABLED"?"disabled":"enabled" } });
    assert.equal((await h.result).reason, reason); assert.equal(h.callbacks.success, undefined);
  });
}
test("native HTTP loopback fails fast even when browser says secureContext=true", async t => {
  const h = setup(t, { protocol: "http:", bridge: {isNativeApp:()=>true} });
  assert.equal((await h.result).reason, "INSECURE_ORIGIN"); assert.equal(h.callbacks.success, undefined);
});
test("public insecure origin is rejected before unavailable geolocation", async t => {
  const h = setup(t, { secureContext: false, protocol: "http:", geolocation: undefined });
  assert.equal((await h.result).reason, "INSECURE_ORIGIN");
});
test("older native bridge remains compatible without optional status methods", async t => {
  const h = setup(t, { bridge: {isNativeApp:()=>true,isLocationPermissionGranted:()=>true} });
  h.callbacks.success(point()); assert.ok((await h.result).location);
  assert.equal(h.diagnostics.at(-1).locationServiceState, "unknown");
});
test("synchronous native callbacks and throwing clearWatch/observer never leave promise pending", async t => {
  const h = setup(t, { geolocation:{ watchPosition(success) {success(point()); return 3;}, clearWatch(){throw new Error("cleanup");} }, onProgress(){throw new Error("observer");} });
  assert.ok((await h.result).location);
});
test("deadline still rejects when clearWatch throws", async t => {
  const h = setup(t, {geolocation:{watchPosition(){return 1},clearWatch(){throw new Error("cleanup")}}});
  t.mock.timers.tick(25_000); assert.equal((await h.result).reason,"TIMEOUT");
});
test("synchronous denial releases a late-assigned watch id", async t => {
  const cleared=[];
  const h = setup(t, { geolocation:{watchPosition(_success,error){error({code:1});return 7;},clearWatch(id){cleared.push(id);}} });
  assert.equal((await h.result).reason,"PERMISSION_DENIED"); assert.deepEqual(cleared,[7]);
});
test("watch registration exceptions and malformed success objects settle UNKNOWN_ERROR", async t => {
  const h = setup(t); h.callbacks.success(null); assert.equal((await h.result).reason,"UNKNOWN_ERROR");
  const broken=gps.createGpsAcquisition({secureContext:true,protocol:"https:",geolocation:{watchPosition(){throw Error("broken")},clearWatch(){}}});
  await assert.rejects(broken.promise,{reason:"UNKNOWN_ERROR"});
});
test("out-of-range timestamps stay bounded and never throw out of callback", async t => {
  const h=setup(t); h.callbacks.success({...point(),timestamp:1e30}); t.mock.timers.tick(25_000);
  assert.equal((await h.result).reason,"STALE");
});
test("wall-clock deadline on resume rejects before an overdue fix can start work", async t => {
  let now=Date.now(); const h=setup(t,{now:()=>now}); now+=25_001; h.callbacks.success(point());
  assert.equal((await h.result).reason,"TIMEOUT");
});
test("cancelling on account change cleans up and rejects; no late progress", async t => {
  const h=setup(t); h.operation.cancel(); const count=h.progress.length; h.callbacks.success(point());
  assert.equal((await h.result).reason,"CANCELLED"); assert.equal(h.progress.length,count); assert.deepEqual(h.cleared,[0]);
});
test("diagnostics contain only the safe allowlist, no GPS or identifiers", async t => {
  const h=setup(t); h.callbacks.success(point()); await h.result;
  assert.deepEqual(Object.keys(h.diagnostics.at(-1)).sort(),["source","nativeApp","secureContext","permissionAny","permissionPrecise","locationServiceState","callback","errorCode","accuracy","ageMs","acquisitionElapsedMs","finalReason"].sort());
});
test("work-start response deadline aborts a hung request and ignores its late result", async t => {
  t.mock.timers.enable({apis:["setTimeout","Date"],now:1_800_000_000_000});
  let signal; let deliver;
  const h=response.createWorkStartDeadline(s=>{signal=s;return new Promise(resolve=>{deliver=resolve})});
  const result=h.promise.catch(error=>error.message); await Promise.resolve(); t.mock.timers.tick(15_000);
  assert.match(await result,/پاسخ ثبت فعالیت نرسید/); assert.equal(signal.aborted,true); deliver({id:"late"});
});
