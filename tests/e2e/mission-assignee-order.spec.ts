import { expect, test, type Page } from "@playwright/test";

test.use({ serviceWorkers: "block" });

type Option = { id: string; fullName: string; username: string; role: string; recentAssignmentCount: number; lastAssignedAt: string | null };
const options = (): Option[] => [
  { id:"employee-b", fullName:"بهرام آزمایشی", username:"bahram", role:"employee", recentAssignmentCount:5, lastAssignedAt:"2026-09-12T08:00:00Z" },
  { id:"employee-a", fullName:"احمد آزمایشی", username:"ahmad", role:"employee", recentAssignmentCount:2, lastAssignedAt:"2026-09-12T09:00:00Z" },
  { id:"employee-c", fullName:"پریسا آزمایشی", username:"parisa", role:"employee", recentAssignmentCount:0, lastAssignedAt:null },
];

async function install(page: Page, backgroundUsersEmpty = false) {
  const state = { accountId:"manager-a", assignees:options(), orderMode:"recent", status:200, responseAccountId:"", reads:0,
    writes:[] as {method:string;body:Record<string,unknown>;accountId:string|undefined}[], hold:null as Promise<void>|null };
  const mission = {id:"mission-fixture",title:"مأموریت انتخاب مسئول آزمایشی",description:"",source:"manager",status:"open",priority:"normal",assignedTo:"employee-c",employeeName:"پریسا آزمایشی",createdAt:"2026-09-12T06:00:00Z",scorePending:0,scoreConfirmed:0,executionRank:5,workflowType:"single",steps:[],tasks:[]};
  await page.route("**/api/**", async route => {
    const request=route.request(), path=new URL(request.url()).pathname;
    const json=(body:unknown,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
    if(path==="/api/auth/me") return json({user:{id:state.accountId,role:"admin",fullName:"مدیر آزمایشی",username:"manager",mustChangePassword:false,notificationEnabled:false}});
    if(path==="/api/missions/assignees") {
      state.reads++;
      expect(request.headers()["x-tapra-user-id"]).toBe(state.accountId);
      const response={accountId:state.responseAccountId||state.accountId,assignees:structuredClone(state.assignees),historyDays:30,orderMode:state.orderMode};
      if(state.hold) await state.hold;
      if(state.status!==200) return json({error:"فهرست آزمایشی در دسترس نیست"},state.status).catch(()=>{});
      return json(response).catch(()=>{});
    }
    if((path==="/api/missions"||path===`/api/missions/${mission.id}`)&&request.method()!=="GET") {
      state.writes.push({method:request.method(),body:request.postDataJSON(),accountId:request.headers()["x-tapra-user-id"]});
      return json({mission:{...mission,...request.postDataJSON()}},request.method()==="POST"?201:200);
    }
    if(path==="/api/missions") return json({missions:[mission]});
    if(path==="/api/admin/users") return json({users:backgroundUsersEmpty ? [] : options().map(user=>({...user,status:"active",mobile:"",supervisorId:null}))});
    if(path==="/api/work-sessions") return json({current:null,today:{activeSeconds:0,activeMinutes:0,firstStartAt:null,lastEndAt:null,unverifiedGpsMinutes:0,pendingCorrectionMinutes:0}});
    if(path==="/api/notifications/settings") return json({userId:state.accountId,enabled:false,configured:false});
    return json({notifications:[],unreadCount:0,openRequestCount:0,attachments:[],events:[],approvals:[],locations:[],destinations:[],segments:[]});
  });
  await page.goto("/?panel=admin&screen=missions");
  await expect(page.getByRole("heading",{name:"مدیریت مأموریت‌ها",exact:true})).toBeVisible();
  return state;
}

async function openNew(page:Page) {
  await page.getByRole("button",{name:/مأموریت جدید/}).first().click();
  await expect(page.getByRole("dialog",{name:"مأموریت جدید",exact:true})).toBeVisible();
  return page.getByRole("combobox",{name:/مسئول مأموریت/});
}

test("recent assignees rank first but new missions require deliberate selection", async ({page},info) => {
  const state=await install(page);
  expect(state.reads).toBe(0);
  const select=await openNew(page);
  await expect(select).toHaveValue("");
  expect(await select.locator("option").evaluateAll(nodes=>nodes.map(node=>(node as HTMLOptionElement).value))).toEqual(["","employee-b","employee-a","employee-c"]);
  await expect(select.locator("optgroup").first()).toHaveAttribute("label","ارجاع‌های پرتکرار اخیر شما");
  const submit=page.getByRole("button",{name:"ثبت و تخصیص مأموریت",exact:true});
  await page.getByRole("textbox",{name:/عنوان مأموریت/}).fill("ثبت آزمایشی مسئول منتخب");
  await expect(submit).toBeDisabled();
  await select.selectOption("employee-b");
  await expect(page.locator("#mission-assignee-help")).toContainText("انتخاب شما: بهرام آزمایشی");
  await expect(submit).toBeEnabled();
  await page.screenshot({path:info.outputPath("recent-assignees-form.png"),fullPage:true});
  await submit.click();
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({method:"POST",accountId:"manager-a",body:{assignedTo:"employee-b"}});
  await openNew(page);
  await expect(select).toHaveValue("");
  expect(state.reads).toBe(2);
});

test("editing preserves the actual assignee even when they are not ranked first", async ({page}) => {
  const state=await install(page);
  await page.getByRole("button",{name:/ویرایش/}).first().click();
  const select=page.getByRole("combobox",{name:/مسئول مأموریت/});
  await expect(select).toHaveValue("employee-c");
  await page.getByRole("button",{name:"ذخیره تغییرات",exact:true}).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(state.writes[0]).toMatchObject({method:"PATCH",accountId:"manager-a",body:{assignedTo:"employee-c"}});
});

test("background roster cannot show an empty-list error beside valid mission assignees", async ({page}) => {
  await install(page, true);
  const select=await openNew(page);
  await expect(select).toBeEnabled();
  await expect(page.locator(".mission-form-error")).toBeHidden();
  await select.selectOption("employee-b");
  await expect(page.locator("#mission-assignee-help")).toContainText("بهرام آزمایشی");
});

test("unavailable current assignee is never silently replaced during edit", async ({page}) => {
  const state=await install(page);
  state.assignees=state.assignees.filter(user=>user.id!=="employee-c");
  await page.getByRole("button",{name:/ویرایش/}).first().click();
  await expect(page.getByRole("combobox",{name:/مسئول مأموریت/})).toHaveValue("");
  await expect(page.getByRole("button",{name:"ذخیره تغییرات",exact:true})).toBeDisabled();
  expect(state.writes).toHaveLength(0);
});

test("server history survives reload but selection does not persist or reorder while typing", async ({page}) => {
  const state=await install(page);
  let select=await openNew(page);
  await select.selectOption("employee-a");
  state.assignees=[...state.assignees].reverse();
  await page.getByRole("textbox",{name:/عنوان مأموریت/}).fill("انتخاب را تغییر نده");
  await expect(select).toHaveValue("employee-a");
  expect(state.reads).toBe(1);
  await page.reload();
  select=await openNew(page);
  await expect(select).toHaveValue("");
  expect(state.reads).toBe(2);
});

test("explicit alphabetical fallback and empty active roster are understandable", async ({page}) => {
  const state=await install(page);
  state.orderMode="name";
  state.assignees=[options()[1],options()[0],options()[2]].map(user=>({...user,recentAssignmentCount:0,lastAssignedAt:null}));
  const select=await openNew(page);
  await expect(page.locator("#mission-assignee-help")).toContainText("سابقه ارجاع دریافت نشد");
  expect(await select.locator("option").count()).toBe(4);
  await page.getByRole("button",{name:"بستن فرم",exact:true}).click();
  state.assignees=[];
  await openNew(page);
  await expect(select).toBeDisabled();
  await expect(page.locator("#mission-assignee-help")).toContainText("کاربر فعال و مجازی");
});

test("failed or mismatched responses cannot reopen a form with stale options", async ({page}) => {
  const state=await install(page);
  await openNew(page);
  await page.getByRole("button",{name:"بستن فرم",exact:true}).click();
  state.status=500;
  await page.getByRole("button",{name:/مأموریت جدید/}).first().click();
  await expect(page.locator(".admin-toast")).toContainText("فهرست آزمایشی");
  await expect(page.getByRole("dialog")).toBeHidden();
  state.status=200;state.responseAccountId="manager-b";
  await page.getByRole("button",{name:/مأموریت جدید/}).first().click();
  await expect(page.locator(".admin-toast")).toContainText("حساب جاری تغییر کرده");
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(state.writes).toHaveLength(0);
});

test("leaving the panel cancels a pending account-specific response", async ({page}) => {
  const state=await install(page);
  let release!:()=>void;
  state.hold=new Promise<void>(resolve=>{release=resolve});
  await page.getByRole("button",{name:/مأموریت جدید/}).first().click();
  await expect.poll(()=>state.reads).toBe(1);
  await page.getByRole("tab",{name:/اپ کارمند/}).click();
  state.accountId="manager-b";
  release();state.hold=null;
  await page.getByRole("tab",{name:/پنل مدیر/}).click();
  await expect(page.getByRole("heading",{name:"مدیریت مأموریت‌ها",exact:true})).toBeVisible();
  await expect(page.getByRole("dialog")).toBeHidden();
  await openNew(page);
  expect(state.reads).toBe(2);
});
