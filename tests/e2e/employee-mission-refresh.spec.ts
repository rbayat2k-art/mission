import { expect, test, type Page } from "@playwright/test";
test.use({serviceWorkers:"block"});
async function setup(page:Page, screen="missions", native=false) {
  const state={userId:"employee-a",missions:[] as Record<string,unknown>[],reads:0,fail:false,statusFails:false,hold:null as Promise<void>|null,writes:[] as string[]};
  if(native)await page.addInitScript(()=>{Object.assign(window,{TapraAndroid:{isNativeApp:()=>true,showNativeNotification:()=>false,showNativeNotificationForUser:()=>false}})});
  await page.route("**/api/**",async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    const json=(body:unknown,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
    if(request.method()!=="GET")state.writes.push(path);
    if(path==="/api/auth/me")return json({user:{id:state.userId,role:"employee",fullName:"آزمایشی",username:"fixture",mustChangePassword:false,notificationEnabled:true}});
    if(path==="/api/missions"){
      state.reads++;expect(request.headers()["x-tapra-user-id"]).toBe(state.userId);
      const payload={userId:state.userId,missions:structuredClone(state.missions)};
      if(state.hold)await state.hold;
      return json(state.fail?{error:"temporary"}:payload,state.fail?503:200).catch(()=>{});
    }
    if(path==="/api/work-sessions")return json({current:null,today:{activeSeconds:0,activeMinutes:0,firstStartAt:null,lastEndAt:null,unverifiedGpsMinutes:0,pendingCorrectionMinutes:0}},state.statusFails?500:200);
    if(path==="/api/notifications/settings")return json({userId:state.userId,enabled:true,configured:false});
    if(path==="/api/notifications")return json({userId:state.userId,unreadCount:1,openRequestCount:0,notifications:[{id:"notice-new",title:"مأموریت",message:"",entityType:"mission",readAt:null}]});
    return json({ok:true,events:[],attachments:[]});
  });
  await page.goto(`/?panel=employee&screen=${screen}`);
  await expect.poll(()=>state.reads).toBeGreaterThan(0);
  return state;
}
const mission=(id="new")=>({id,title:`مأموریت جدید ${id}`,assignedTo:"employee-a",status:"open",source:"manager",priority:"normal",workflowType:"single",createdAt:new Date().toISOString(),executionRank:1,steps:[],tasks:[]});
const focus=(page:Page)=>page.evaluate(()=>window.dispatchEvent(new Event("focus")));

test("idle employee receives a new assignment without reload or active shift",async({page})=>{
  const state=await setup(page);state.missions=[mission()];state.statusFails=true;
  await expect(page.getByRole("heading",{name:"مأموریت جدید new",exact:true})).toBeVisible({timeout:15_000});
  expect(state.writes).toEqual([]);
});
test("foreground and reconnect refresh immediately; errors preserve the list",async({page})=>{
  const state=await setup(page);state.missions=[mission()];await focus(page);
  await expect(page.getByRole("heading",{name:"مأموریت جدید new",exact:true})).toBeVisible();
  state.fail=true;await focus(page);
  await expect(page.getByRole("heading",{name:"مأموریت جدید new",exact:true})).toBeVisible();
  state.fail=false;state.missions=[mission("next")];
  await page.evaluate(()=>window.dispatchEvent(new Event("online")));
  await expect(page.getByRole("heading",{name:"مأموریت جدید next",exact:true})).toBeVisible();
});
test("refresh does not reset an employee's draft or navigation",async({page})=>{
  const state=await setup(page,"new");
  const title=page.getByPlaceholder("مثلاً: پیگیری بیمه خودرو");
  await title.fill("متن ذخیره‌نشده من");state.missions=[mission()];const before=state.reads;await focus(page);
  await expect.poll(()=>state.reads).toBeGreaterThan(before);await expect(title).toHaveValue("متن ذخیره‌نشده من");
  expect(state.writes).toEqual([]);
});
test("foreign-account notifications do not trigger a read; own signal does",async({page})=>{
  const state=await setup(page);await page.waitForTimeout(150);const before=state.reads;
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent("tapra-missions-changed",{detail:{userId:"other"}})));
  await page.waitForTimeout(150);expect(state.reads).toBe(before);
  state.missions=[mission()];await page.evaluate(()=>window.dispatchEvent(new CustomEvent("tapra-missions-changed",{detail:{userId:"employee-a"}})));
  await expect(page.getByRole("heading",{name:"مأموریت جدید new",exact:true})).toBeVisible();
});
test("native notification signals refresh even when native display was deduplicated",async({page})=>{
  await page.addInitScript(()=>{window.addEventListener("tapra-missions-changed",()=>{document.documentElement.dataset.missionSignal="received"})});
  await setup(page,"missions",true);
  await expect(page.locator("html")).toHaveAttribute("data-mission-signal","received");
});
