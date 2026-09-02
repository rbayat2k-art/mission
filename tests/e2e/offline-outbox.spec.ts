import { expect, test } from "@playwright/test";

type SeedEntry = {
  id?:number;
  accountId?:string;
  kind:"json";
  url:string;
  method:string;
  body:Record<string,unknown>;
  createdAt:string;
};

const employee = (id:string, username:string) => ({
  id,
  username,
  role:"employee",
  mustChangePassword:false,
  fullName:username === "employee-a" ? "کارمند الف" : "کارمند ب",
  notificationEnabled:true,
});

test("outbox keeps conflicts account-scoped, quarantines legacy data, and safely rebases task results", async ({ page }) => {
  let activeUser:ReturnType<typeof employee>|null = null;
  let taskPatchAttempts = 0;
  let accountBDestinationAttempts = 0;
  let rebasedBody:Record<string,unknown>|null = null;

  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const json = (body:unknown, status=200) => route.fulfill({ status, contentType:"application/json", body:JSON.stringify(body) });

    if (path === "/api/auth/me") return activeUser ? json({user:activeUser}) : json({error:"unauthorized"}, 401);
    if (path === "/api/auth/login") {
      const username = String(request.postDataJSON()?.username ?? "");
      activeUser = employee(username === "employee-b" ? "account-b" : "account-a", username);
      return json({user:activeUser});
    }
    if (path === "/api/auth/logout") { activeUser = null; return json({ok:true}); }
    if (path === "/api/missions" && request.method() === "GET") return json({missions:[{
      id:"mission-a", title:"ماموریت تست", description:"", source:"manager", status:"in_progress", priority:"normal",
      workflowType:"task_list", scorePending:0, scoreConfirmed:0,
      tasks:[{id:"task-a",missionId:"mission-a",taskNo:1,title:"کار اول",description:"",status:"open",version:2}],
    }]});
    if (path === "/api/work-sessions" && request.method() === "GET") return json({
      current:null, autoEnded:false,
      today:{activeSeconds:0,activeMinutes:0,firstStartAt:null,lastEndAt:null,unverifiedGpsMinutes:0,pendingCorrectionMinutes:0},
    });
    if (path === "/api/notifications") return json({unreadCount:0,openRequestCount:0,notifications:[]});
    if (path === "/api/missions/mission-a/tasks/task-a" && request.method() === "PATCH") {
      taskPatchAttempts += 1;
      if (taskPatchAttempts === 1) return json({error:"private text must not be displayed",code:"TASK_VERSION_CONFLICT",currentVersion:2},409);
      rebasedBody = request.postDataJSON() as Record<string,unknown>;
      return json({task:{id:"task-a",missionId:"mission-a",taskNo:1,title:"کار اول",description:"",status:"completed",version:3}});
    }
    if (path === "/api/missions/mission-a/complete") return json({error:"sensitive completion conflict"},409);
    if (path === "/api/destinations" && request.method() === "POST") {
      accountBDestinationAttempts += 1;
      return json({destination:{id:"destination-b"}});
    }
    return json({});
  });

  await page.goto("/?panel=employee&screen=home");
  await page.evaluate(async () => {
    const entries:SeedEntry[] = [
      {accountId:"account-a",kind:"json",url:"/api/missions/mission-a/tasks/task-a",method:"PATCH",body:{result:"انجام شد",report:"private report",expectedVersion:1,clientEventId:"11111111-1111-4111-8111-111111111111"},createdAt:"2026-08-18T08:00:00.000Z"},
      {accountId:"account-a",kind:"json",url:"/api/missions/mission-a/complete",method:"POST",body:{report:"private completion",latitude:35.1,longitude:51.1},createdAt:"2026-08-18T08:01:00.000Z"},
      {accountId:"account-b",kind:"json",url:"/api/destinations",method:"POST",body:{missionId:"mission-b"},createdAt:"2026-08-18T08:02:00.000Z"},
      {kind:"json",url:"/api/destinations",method:"POST",body:{missionId:"legacy"},createdAt:"2026-08-18T08:03:00.000Z"},
    ];
    await new Promise<void>((resolve,reject)=>{
      const open=indexedDB.open("rahkar-offline-v1",1);
      open.onupgradeneeded=()=>open.result.createObjectStore("outbox",{keyPath:"id",autoIncrement:true});
      open.onerror=()=>reject(open.error);
      open.onsuccess=()=>{
        const db=open.result;
        const transaction=db.transaction("outbox","readwrite");
        const store=transaction.objectStore("outbox");
        entries.forEach(entry=>store.add(entry));
        transaction.oncomplete=()=>{db.close();resolve()};
        transaction.onerror=()=>reject(transaction.error);
      };
    });
  });

  await page.getByLabel("نام کاربری").fill("employee-a");
  await page.getByLabel("رمز عبور").fill("test-password");
  await page.getByRole("button",{name:"ورود به پنل"}).click();

  await expect(page.getByText(/تعارض ۱ از ۲/)).toBeVisible();
  await expect(page.getByText(/اطلاعات نسخه قدیمی قرنطینه شده/)).toBeVisible();
  await expect(page.getByText(/private text|private report|latitude|longitude/i)).toHaveCount(0);
  await expect.poll(()=>taskPatchAttempts).toBe(1);
  expect(accountBDestinationAttempts).toBe(0);

  await page.reload();
  await expect(page.getByText(/تعارض ۱ از ۲/)).toBeVisible();
  await expect.poll(()=>taskPatchAttempts).toBe(1);

  page.once("dialog", dialog=>dialog.accept());
  await page.getByRole("button",{name:"اعمال مجدد تغییر"}).click();
  await expect.poll(()=>taskPatchAttempts).toBe(2);
  const submittedRebase = rebasedBody as unknown as Record<string,unknown>;
  expect(submittedRebase.expectedVersion).toBe(2);
  expect(submittedRebase.clientEventId).not.toBe("11111111-1111-4111-8111-111111111111");
  await expect(page.getByText(/تعارض ۱ از ۱/)).toBeVisible();
  await expect(page.getByRole("button",{name:"اعمال مجدد تغییر"})).toHaveCount(0);

  page.once("dialog", dialog=>dialog.accept());
  await page.getByRole("button",{name:"حذف همین تغییر محلی"}).click();
  await expect(page.getByText(/تعارض ۱ از/)).toHaveCount(0);
  expect(accountBDestinationAttempts).toBe(0);

  const remainingAfterA = await page.evaluate(async () => new Promise<SeedEntry[]>((resolve,reject)=>{
    const open=indexedDB.open("rahkar-offline-v1",1);
    open.onerror=()=>reject(open.error);
    open.onsuccess=()=>{
      const db=open.result;
      const request=db.transaction("outbox","readonly").objectStore("outbox").getAll();
      request.onsuccess=()=>{db.close();resolve(request.result as SeedEntry[])};
      request.onerror=()=>reject(request.error);
    };
  }));
  expect(remainingAfterA.map(entry=>entry.accountId ?? "legacy").sort()).toEqual(["account-b","legacy"]);

  await page.getByLabel("پروفایل").click();
  await page.getByRole("button",{name:/خروج از حساب/}).click();
  await page.getByLabel("نام کاربری").fill("employee-b");
  await page.getByLabel("رمز عبور").fill("test-password");
  await page.getByRole("button",{name:"ورود به پنل"}).click();
  await expect.poll(()=>accountBDestinationAttempts).toBe(1);
  await expect(page.getByText(/اطلاعات نسخه قدیمی قرنطینه شده/)).toBeVisible();
});
