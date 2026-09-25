import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";

// Render the actual application against shared synthetic HTTP fixtures. API SQL,
// access control and idempotency are exercised separately in workflow unit tests.
function workflowState(){return {
  messages:[] as {id:string;senderId:string;senderName:string;senderRole:string;messageType:string;body:string;createdAt:string}[],
  attachments:[] as {id:string;messageId:string;fileName:string;contentType:string;sizeBytes:number;uploadedByName:string}[],
  sends:[] as {text:string;clientMessageId:string}[], uploads:[] as string[], decisions:[] as unknown[],
  failSecondFile:true,status:"awaiting_supervisor", notificationFailure:false,readFailure:false,readAt:null as string|null,
  missionPosts:[] as Record<string,unknown>[],failMissionRefresh:false,
}}
async function install(page:Page,role:"admin"|"employee"|"supervisor",state:ReturnType<typeof workflowState>){
  const user={id:`${role}-fixture`,role,fullName:`${role} آزمایشی`,username:`${role}-test`,mustChangePassword:false,notificationEnabled:false};
  const request=(suffix="a")=>({id:`request-${suffix}`,missionId:`mission-${suffix}`,missionTitle:`پیگیری آزمایشی ${suffix}`,missionStatus:"follow_up",employeeId:"employee-fixture",employeeName:"کارمند آزمایشی",supervisorName:"سرپرست آزمایشی",assignedToName:"مدیر آزمایشی",category:"coordination",requestText:"درخواست آزمایشی",status:state.status,createdAt:"2026-09-09T08:00:00Z",updatedAt:"2026-09-09T08:00:00Z"});
  await page.route("**/api/**",async route=>{
    const http=route.request(),url=new URL(http.url()),path=url.pathname;
    const json=(body:unknown,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
    if(path==="/api/auth/me")return json({user});
    if(path==="/api/notifications/settings")return json({userId:user.id,enabled:false,configured:false});
    if(path==="/api/notifications"){
      if(http.method()==="PATCH"){
        expect(http.headers()["x-tapra-user-id"]).toBe(user.id);
        if(state.readFailure)return json({error:"test read failure"},500);
        state.readAt=new Date().toISOString();return json({ok:true});
      }
      if(state.notificationFailure)return json({error:"test transport failure"},500);
      return json({userId:user.id,notifications:[{id:`notice-${role}`,type:"follow_up_message",title:`اعلان اختصاصی ${role}`,message:"پیام آزمایشی",entityType:"follow_up_request",entityId:"request-a",readAt:state.readAt,createdAt:"2026-09-09T08:00:00Z"}],unreadCount:state.readAt?0:1,openRequestCount:1});
    }
    if(path==="/api/missions"){
      if(http.method()==="POST"){state.missionPosts.push(http.postDataJSON());expect(http.headers()["x-tapra-user-id"]).toBe(user.id);return json({id:"new-mission"},201)}
      if(state.failMissionRefresh&&state.missionPosts.length)return json({error:"test reload failure"},500);
      return json({missions:[{id:"mission-a",title:"پیگیری آزمایشی a",status:"follow_up",source:"admin",priority:"normal",createdAt:"2026-09-09T08:00:00Z",description:"راهنمای آزمایشی",workflowType:"single",scoreConfirmed:0,scorePending:0,followUpRequestStatus:state.status,result:"نیاز به پیگیری"}]});
    }
    if(path==="/api/work-sessions")return json({current:null,today:{activeSeconds:0,activeMinutes:0,unverifiedGpsMinutes:0,pendingCorrectionMinutes:0,firstStartAt:null,lastEndAt:null}});
    if(path==="/api/employee/daily-summary")return json({summary:{period:"daily",date:"2026-09-24",completed:[],incomplete:[],destinations:[],locationSummary:{pointCount:0,firstAt:null,lastAt:null},sessions:[],firstStartAt:null,lastEndAt:null,activeMinutes:0,rawSessionMinutes:0,unverifiedGpsMinutes:0,pendingCorrectionMinutes:0,requiredMinutes:510,overtimeStartsAtMinutes:540,overtimeMinutes:0,confirmedScore:0,pendingScore:0,confirmationMissionIds:[],performance:null,policy:{standardStart:"08:00",standardDailyMinutes:510,note:"داده آزمایشی"}}});
    if(path==="/api/follow-up-requests")return json({requests:[request(),request("b")]});
    if(/^\/api\/follow-up-requests\/request-[ab]$/.test(path))return json({request:request(path.endsWith("b")?"b":"a"),messages:state.messages,attachments:state.attachments});
    if(path.endsWith("/messages")){
      expect(http.headers()["x-tapra-user-id"]).toBe(user.id);
      const body=http.postDataJSON();state.sends.push(body);
      const message={id:body.clientMessageId,senderId:user.id,senderName:user.fullName,senderRole:role,messageType:"text",body:body.text,createdAt:new Date().toISOString()};
      state.messages.push(message);return json({message},201);
    }
    if(path.endsWith("/decision")){state.decisions.push(http.postDataJSON());state.status="ready_for_employee";return json({ok:true})}
    if(path==="/api/attachments"){
      if(http.method()==="GET")return json({attachments:[]});
      const data=http.postDataBuffer()?.toString()||"";
      const filename=/filename="([^"]+)"/.exec(data)?.[1]||"";
      const messageId=/name="messageId"\r\n\r\n([^\r]+)/.exec(data)?.[1]||"";
      state.uploads.push(filename);expect(state.messages.some(message=>message.id===messageId)).toBe(true);
      expect(http.headers()["x-tapra-user-id"]).toBe(user.id);
      if(filename==="second.txt"&&state.failSecondFile){state.failSecondFile=false;return json({error:"ارسال فایل آزمایشی ناموفق بود"},503)}
      state.attachments.push({id:`file-${state.attachments.length}`,messageId,fileName:filename,contentType:"text/plain",sizeBytes:10,uploadedByName:user.fullName});return json({ok:true},201);
    }
    return json({users:[],events:[],approvals:[],locations:[],destinations:[],segments:[]});
  });
}

test("manager and employee exchange replies, partial file retry sends only remaining files, then manager returns follow-up",async({page,context},info)=>{
  const state=workflowState();await install(page,"admin",state);
  await page.goto("/?panel=admin&screen=actions");
  const thread=page.locator(".follow-up-thread");
  await thread.getByPlaceholder("پاسخ یا راهنمایی برای کارمند...").fill("راهنمای آزمایشی مدیر");
  await thread.locator('input[type="file"]').setInputFiles([{name:"first.txt",mimeType:"text/plain",buffer:Buffer.from("synthetic one")},{name:"second.txt",mimeType:"text/plain",buffer:Buffer.from("synthetic two")}]);
  await thread.getByRole("button",{name:"ارسال",exact:true}).click();
  await expect(thread.getByRole("button",{name:"ارسال فایل‌های باقیمانده"})).toBeVisible();
  expect(state.sends).toHaveLength(1);expect(state.uploads).toEqual(["first.txt","second.txt"]);
  await thread.getByRole("button",{name:"ارسال فایل‌های باقیمانده"}).click();
  await expect(thread.getByRole("link",{name:/second.txt/})).toBeVisible();
  expect(state.sends).toHaveLength(1);expect(state.uploads).toEqual(["first.txt","second.txt","second.txt"]);
  await page.screenshot({path:info.outputPath("manager-follow-up.png")});
  const employee=await context.newPage();await install(employee,"employee",state);
  await employee.goto("/?panel=employee&screen=missions");
  await employee.locator(".mission-tabs").getByRole("button",{name:/پیگیری/}).click();
  await employee.getByRole("heading",{name:"پیگیری آزمایشی a",exact:true}).click();
  await expect(employee.locator(".follow-up-thread")).toContainText("راهنمای آزمایشی مدیر");
  await employee.getByPlaceholder("پاسخ کوتاه به سرپرست...").fill("پاسخ آزمایشی کارمند");
  await employee.locator(".follow-up-thread").getByRole("button",{name:"ارسال",exact:true}).click();
  await expect(employee.locator(".follow-up-messages")).toContainText("پاسخ آزمایشی کارمند");
  await employee.screenshot({path:info.outputPath("employee-follow-up.png")});
  await page.reload();await expect(page.locator(".follow-up-messages")).toContainText("پاسخ آزمایشی کارمند");
  await page.getByRole("button",{name:"بازگشت به پیگیری",exact:true}).click();
  await page.getByPlaceholder("علت تصمیم یا کاری که باید انجام شود...").fill("مدارک آماده است؛ پیگیری کنید");
  await page.getByRole("button",{name:"ثبت تصمیم و ارسال اعلان"}).click();
  await expect.poll(()=>state.decisions.length).toBe(1);
  expect(state.decisions[0]).toEqual({action:"return_to_employee",note:"مدارک آماده است؛ پیگیری کنید"});
});

test("switching supervisor conversations ignores a late response from the previous request",async({page})=>{
  const state=workflowState();await install(page,"supervisor",state);
  let release!:()=>void,seen=false;const held=new Promise<void>(resolve=>{release=resolve});
  await page.route("**/api/follow-up-requests/request-a",async route=>{seen=true;await held;await route.fulfill({contentType:"application/json",body:'{"request":{"id":"obsolete"}}'}).catch(()=>{})});
  await page.goto("/?panel=admin&screen=actions");await expect.poll(()=>seen).toBe(true);
  await page.locator(".follow-up-queue").getByRole("button",{name:/پیگیری آزمایشی b/}).click();
  await expect(page.locator(".follow-up-thread h3")).toHaveText("پیگیری آزمایشی b");
  release();await expect(page.locator(".follow-up-thread h3")).toHaveText("پیگیری آزمایشی b");
  await page.getByPlaceholder("پاسخ یا راهنمایی برای کارمند...").fill("پاسخ درخواست دوم");
  const received=page.waitForRequest(request=>request.method()==="POST"&&request.url().endsWith("/request-b/messages"));
  await page.locator(".follow-up-thread").getByRole("button",{name:"ارسال",exact:true}).click();await received;
});

test("employee mission retains description, priority and deadline and ignores simultaneous submissions",async({page})=>{
  const state=workflowState();state.failMissionRefresh=true;await install(page,"employee",state);
  await page.goto("/?panel=employee&screen=new");
  await page.getByPlaceholder("مثلاً: پیگیری بیمه خودرو").fill("مأموریت فرم آزمایشی");
  await page.getByPlaceholder("جزئیات لازم برای انجام کار...").fill("شرحی که باید ذخیره شود");
  await page.locator(".mobile-form select").selectOption("urgent");
  await page.getByPlaceholder("۱۴۰۵/۰۷/۰۱").fill("۱۴۰۵/۰۷/۰۱");await page.getByPlaceholder("۱۴:۳۰").fill("۱۴:۳۰");
  await page.locator(".mobile-form").evaluate(form=>{form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))});
  await expect(page.getByText(/دوباره مأموریت نسازید/)).toBeVisible();
  expect(state.missionPosts).toHaveLength(1);
  expect(state.missionPosts[0]).toMatchObject({title:"مأموریت فرم آزمایشی",description:"شرحی که باید ذخیره شود",priority:"urgent",deadlineDate:"۱۴۰۵/۰۷/۰۱",deadlineTime:"۱۴:۳۰"});
});

test("notification errors cannot masquerade as an empty inbox or successful read",async({page})=>{
  const state=workflowState();state.notificationFailure=true;await install(page,"employee",state);
  await page.goto("/?panel=employee&screen=notifications");
  await expect(page.locator(".notification-center").getByRole("alert")).toContainText("دریافت اعلان‌ها ناموفق بود");
  await expect(page.getByText("اعلان تازه‌ای ندارید",{exact:true})).toHaveCount(0);
  state.notificationFailure=false;
  await page.getByRole("button",{name:"دریافت دوباره اعلان‌ها"}).click();
  await expect(page.getByRole("button",{name:/اعلان اختصاصی employee/})).toBeVisible();
  state.readFailure=true;await page.getByRole("button",{name:/اعلان اختصاصی employee/}).click();
  await expect(page.locator(".notification-center").getByRole("alert")).toContainText("ثبت خواندن اعلان ناموفق بود");
  expect(state.readAt).toBeNull();expect(page.url()).toContain("screen=notifications");
  state.readFailure=false;await page.getByRole("button",{name:/اعلان اختصاصی employee/}).click();
  await expect(page.getByRole("heading",{name:"مأموریت‌های من",exact:true})).toBeVisible();
  expect(state.readAt).not.toBeNull();
});

async function nativeFixture(page:Page,holdJson:boolean){
  await page.addInitScript(hold=>{
    const state={calls:[] as string[][],waiting:false,release:()=>{}};
    Object.assign(window,{nativeTest:state,TapraAndroid:{
      isNativeApp:()=>true,setAuthenticatedUser:()=>{},clearAuthenticatedUser:()=>{},setTrackingActive:()=>{},isBatteryOptimizationExempt:()=>true,
      showNativeNotification:(...args:string[])=>{state.calls.push(["legacy",...args]);return true},
      showNativeNotificationForUser:(...args:string[])=>{state.calls.push(args);return true},
    }});
    if(hold){
      const original=window.fetch.bind(window);
      window.fetch=async(input,init)=>{
        const response=await original(input,init);
        // Hold a decoded native-poll response, not the independent inbox fetch.
        if(String(input)==="/api/notifications"&&init?.signal&&new Headers(init.headers).has("X-Tapra-User-Id")){
          const json=response.json.bind(response);
          response.json=async()=>{const body=await json();state.waiting=true;await new Promise<void>(resolve=>{state.release=resolve});return body};
        }
        return response;
      };
    }
  },holdJson);
  await install(page,"employee",workflowState());
  await page.route("**/api/notifications/settings",route=>route.fulfill({contentType:"application/json",body:JSON.stringify({userId:"employee-fixture",enabled:true,configured:false})}));
}

test("native notification forwarding carries the expected account to the Android bridge",async({page})=>{
  await nativeFixture(page,false);await page.goto("/?panel=employee&screen=home");
  const calls=()=>page.evaluate(()=>(window as unknown as {nativeTest:{calls:string[][]}}).nativeTest.calls);
  await expect.poll(async()=>(await calls()).length).toBeGreaterThan(0);
  expect((await calls())[0].slice(0,2)).toEqual(["employee-fixture","notice-employee"]);
  expect((await calls()).some(call=>call[0]==="legacy")).toBe(false);
});

test("logging out while native JSON is pending prevents a previous account notification",async({page})=>{
  await nativeFixture(page,true);await page.goto("/?panel=employee&screen=home");
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {nativeTest:{waiting:boolean}}).nativeTest.waiting)).toBe(true);
  await page.getByRole("button",{name:"پروفایل",exact:true}).click();
  const logout=page.waitForResponse(response=>response.url().endsWith("/api/auth/logout"));
  await page.getByRole("button",{name:/خروج از حساب/}).click();await logout;
  await expect(page.locator(".profile-screen")).toHaveCount(0);
  await page.evaluate(async()=>{const state=(window as unknown as {nativeTest:{release:()=>void}}).nativeTest;state.release();await new Promise(resolve=>setTimeout(resolve,100))});
  expect(await page.evaluate(()=>(window as unknown as {nativeTest:{calls:string[][]}}).nativeTest.calls)).toEqual([]);
});

test("mission start, destination, every task and completion survive rapid repeated clicks",async({page,context})=>{
  await context.grantPermissions(["geolocation"]);await context.setGeolocation({latitude:35,longitude:51,accuracy:5});
  await install(page,"employee",workflowState());
  const now=new Date().toISOString();
  const mission={id:"mission-task",title:"مأموریت دو کار آزمایشی",status:"open",source:"admin",priority:"normal",workflowType:"task_list",createdAt:now,startedAt:null as string|null,destinationName:"مقصد آزمایشی",tasks:[1,2].map(index=>({id:`task-${index}`,taskNo:index,title:`کار آزمایشی ${index}`,description:"",status:"open",result:null as string|null,report:null as string|null,version:1}))};
  const counts={start:0,destination:0,task1:0,task2:0,complete:0};
  await page.route("**/api/missions",route=>route.fulfill({contentType:"application/json",body:JSON.stringify({missions:[mission]})}));
  await page.route("**/api/work-sessions",route=>route.fulfill({contentType:"application/json",body:JSON.stringify({current:{id:"session-fixture",startedAt:now},today:{activeSeconds:30,activeMinutes:0,unverifiedGpsMinutes:0,pendingCorrectionMinutes:0,firstStartAt:now,lastEndAt:null}})}));
  await page.route("**/api/missions/mission-task/start",route=>{
    counts.start++;mission.status="in_progress";mission.startedAt=now;
    return route.fulfill({contentType:"application/json",body:JSON.stringify({mission})});
  });
  await page.route("**/api/destinations",route=>{
    counts.destination++;
    return route.fulfill({contentType:"application/json",body:JSON.stringify({destination:{id:"destination-fixture"}})});
  });
  await page.route("**/api/missions/mission-task/tasks/*",route=>{
    const body=route.request().postDataJSON();const index=route.request().url().endsWith("task-1")?0:1;
    counts[index===0?"task1":"task2"]++;
    const task=mission.tasks[index];Object.assign(task,{status:"completed",result:body.result,report:body.report,version:body.expectedVersion+1});
    return route.fulfill({contentType:"application/json",body:JSON.stringify({task})});
  });
  await page.route("**/api/missions/mission-task/complete",route=>{
    counts.complete++;mission.status="approved";
    expect(mission.tasks.every(task=>task.status==="completed")).toBe(true);
    return route.fulfill({contentType:"application/json",body:JSON.stringify({mission:{status:"approved",scoreConfirmed:12,scorePenalty:0}})});
  });
  const twice=async(locator:ReturnType<Page["getByRole"]>)=>locator.evaluate(element=>{(element as HTMLButtonElement).click();(element as HTMLButtonElement).click()});
  await page.goto("/?panel=employee&screen=home");
  await expect(page.locator(".connection-row")).toContainText("GPS تازه · دقت 5 متر");
  await page.getByRole("button",{name:/مأموریت‌ها/}).last().click();
  await page.getByRole("heading",{name:mission.title,exact:true}).click();
  await twice(page.getByRole("button",{name:"شروع این مأموریت",exact:true}));
  await expect(page.getByRole("heading",{name:"ثبت مقصد",exact:true})).toBeVisible();
  await twice(page.getByRole("button",{name:"ثبت مقصد و ادامه",exact:true}));
  await expect(page.getByRole("button",{name:"ادامه و مرور نهایی مأموریت"})).toBeDisabled();
  await expect(page.getByRole("button",{name:"ثبت نتیجه این کار",exact:true})).toBeDisabled();
  await page.locator(".task-result-editor").getByRole("button",{name:"انجام شد",exact:true}).click();
  await twice(page.getByRole("button",{name:"ثبت نتیجه این کار",exact:true}));
  await expect(page.locator(".task-checklist-items article.active")).toContainText("کار آزمایشی 2");
  await expect(page.getByRole("button",{name:"ادامه و مرور نهایی مأموریت"})).toBeDisabled();
  await expect(page.getByRole("button",{name:"ثبت نتیجه این کار",exact:true})).toBeDisabled();
  await page.locator(".task-result-editor").getByRole("button",{name:"انجام شد",exact:true}).click();
  await twice(page.getByRole("button",{name:"ثبت نتیجه این کار",exact:true}));
  await page.getByRole("button",{name:"ادامه و مرور نهایی مأموریت"}).click();
  await page.getByRole("button",{name:"مرور نهایی",exact:true}).click();
  await twice(page.getByRole("button",{name:"پایان مأموریت و ثبت گزارش",exact:true}));
  await expect(page.getByRole("heading",{name:"گزارش با موفقیت ارسال شد"})).toBeVisible();
  expect(counts).toEqual({start:1,destination:1,task1:1,task2:1,complete:1});
});

async function focusedMission(page:Page,options:{arrived?:boolean;active?:boolean;capacity?:boolean;staged?:boolean}={}){
  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation({latitude:35,longitude:51,accuracy:5});
  await install(page,"employee",workflowState());
  const now=new Date().toISOString();
  const mission={id:"focused-mission",title:"بررسی مدارک در مقصد آزمایشی",description:"مدارک را با مسئول مقصد بررسی کنید.",status:options.arrived?"in_progress":"open",source:"admin",priority:"normal",workflowType:options.staged?"multi_stage":"single",createdAt:now,startedAt:options.arrived?now:null,destinationRegisteredAt:options.arrived?now:null,destinationName:"مقصد آزمایشی",currentStepNo:options.staged?2:1,steps:options.staged?[{id:"step-one",stepNo:1,title:"مرحله تمام‌شده",status:"completed",requiresLocation:true,startedAt:now,arrivedAt:now},{id:"step-two",stepNo:2,title:"مقصد دوم",status:options.arrived?"arrived":"open",requiresLocation:true,startedAt:now,arrivedAt:options.arrived?now:null}]:[]};
  const mutations:string[]=[];
  await page.route("**/api/missions",route=>route.fulfill({contentType:"application/json",body:JSON.stringify({missions:[mission,...(options.capacity?[1,2,3].map(id=>({...mission,id:`busy-${id}`,title:`کار فعال ${id}`,status:"in_progress",startedAt:now})):[])]})}));
  await page.route("**/api/work-sessions",route=>route.fulfill({contentType:"application/json",body:JSON.stringify({current:options.active===false?null:{id:"session-fixture",startedAt:now},today:{activeSeconds:30,activeMinutes:0,unverifiedGpsMinutes:0,pendingCorrectionMinutes:0,firstStartAt:now,lastEndAt:null}})}));
  page.on("request",request=>{if(["POST","PATCH","DELETE"].includes(request.method())&&/\/api\/(missions|destinations)/.test(request.url()))mutations.push(new URL(request.url()).pathname)});
  const open=async()=>{
    await page.goto("/?panel=employee&screen=missions");
    if(options.arrived)await page.locator(".mission-tabs").getByRole("button",{name:/در حال انجام/}).click();
    await page.getByRole("heading",{name:mission.title,exact:true}).click();
    await expect(page.locator(".mission-focus-actions")).toBeVisible();
  };
  await open();return {mission,mutations,open};
}

test("employee sees one next action; dangerous no-start shortcut needs a separate explicit confirmation",async({page},info)=>{
  const {mutations}=await focusedMission(page);
  await expect(page.locator(".mission-main-action")).toHaveText("شروع این مأموریت");
  await expect(page.locator(".mission-focus-actions").getByRole("button")).toHaveCount(1);
  const shortcut=page.getByRole("button",{name:"ثبت نتیجه بدون شروع مأموریت",exact:true});
  await expect(shortcut).toBeHidden();await expect(page.locator(".mission-history")).not.toHaveAttribute("open","");
  expect(mutations).toEqual([]);
  await page.locator(".mission-other-actions summary").click();await expect(shortcut).toBeVisible();
  let confirmed=false;page.once("dialog",async dialog=>{expect(dialog.type()).toBe("confirm");expect(dialog.message()).toContain("۳ امتیاز");confirmed=true;await dialog.dismiss()});
  await shortcut.click();expect(confirmed).toBe(true);expect(mutations).toEqual([]);
  await expect(page.locator(".mission-focus-actions")).toBeVisible();
  await page.locator(".mission-other-actions summary").click();
  await page.addScriptTag({content:axe.source});
  const violations=await page.evaluate(async()=>{
    const result=await (window as typeof window&{axe:typeof axe}).axe.run(".mission-focus-actions");
    return result.violations.map(item=>({id:item.id,impact:item.impact}));
  });
  expect(violations).toEqual([]);
  if(info.project.name==="android-chrome"){
    await page.setViewportSize({width:360,height:800});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    const button=await page.locator(".mission-main-action").boundingBox();expect(button?.height).toBeGreaterThanOrEqual(56);
  }
  await page.screenshot({path:info.outputPath("employee-next-action.png"),fullPage:true});
});

test("reopening an arrived mission resumes its result, never submits another start or destination, and preserves edits",async({page},info)=>{
  const {mission,mutations,open}=await focusedMission(page,{arrived:true});
  // Re-fetch the server fixture as happens after closing/reopening the page.
  await open();await expect(page.locator(".mission-main-action")).toHaveText("ثبت نتیجه این مأموریت");
  await page.locator(".mission-main-action").click();
  await expect(page.getByRole("heading",{name:"نتیجه کار چه بود؟",exact:true})).toBeVisible();
  await expect(page.locator(".work-mission-context")).toContainText(mission.title);
  const stepsBox=await page.locator(".work-flow .stepper").boundingBox();
  const panelBox=await page.locator(".work-flow .flow-panel").boundingBox();
  expect(stepsBox?.height).toBeGreaterThanOrEqual(62);
  expect(panelBox!.y).toBeGreaterThanOrEqual(stepsBox!.y+stepsBox!.height);
  await expect(page.getByRole("button",{name:"ادامه",exact:true})).toBeDisabled();
  await expect(page.locator('.result-grid [aria-pressed="true"]')).toHaveCount(0);
  await page.locator(".result-grid").getByRole("button",{name:"انجام شد",exact:true}).click();
  const report=page.locator(".flow-panel textarea");await report.fill("نتیجه آزمایشی که نباید هنگام ویرایش پاک شود");
  await page.getByRole("button",{name:"ادامه",exact:true}).click();
  await page.getByRole("button",{name:"مرور نهایی",exact:true}).click();
  await page.getByRole("button",{name:"→ ویرایش مرحله قبل",exact:true}).click();
  await page.getByRole("button",{name:"→ ویرایش مرحله قبل",exact:true}).click();
  await expect(report).toHaveValue("نتیجه آزمایشی که نباید هنگام ویرایش پاک شود");
  expect(mutations).toEqual([]);
  await page.locator(".app-content").evaluate(element=>{element.scrollTop=0});
  await page.screenshot({path:info.outputPath("employee-result-step.png"),fullPage:true});
});

test("simplified employee action still respects active-shift and three-mission limits",async({page})=>{
  await focusedMission(page,{active:false});
  await expect(page.locator(".mission-main-action")).toBeDisabled();
  await expect(page.getByRole("button",{name:"رفتن به شروع فعالیت روزانه"})).toBeVisible();
  await page.unrouteAll({behavior:"wait"});
  await focusedMission(page,{capacity:true});
  await expect(page.locator(".capacity-lock")).toContainText("ظرفیت مأموریت‌های هم‌زمان تکمیل است");
  await expect(page.locator(".mission-main-action")).toBeDisabled();
});

// GPS incident regressions render the real page. Location and API responses are synthetic.
type GpsHarnessWindow = Window & { gpsTest: { success: PositionCallback[]; errors: PositionErrorCallback[]; cleared: number[] } };
async function workStartIncident(page: Page, baseURL: string, native?: "approximate" | "denied" | "off" | "http") {
  await page.clock.install();
  await page.addInitScript(({native}) => {
    const w = window as unknown as GpsHarnessWindow;
    w.gpsTest = {success:[],errors:[],cleared:[]};
    Object.defineProperty(navigator,"geolocation",{configurable:true,value:{
      watchPosition:(success:PositionCallback,error:PositionErrorCallback)=>{w.gpsTest.success.push(success);w.gpsTest.errors.push(error);return w.gpsTest.success.length;},
      clearWatch:(id:number)=>w.gpsTest.cleared.push(id),
    }});
    if(native) Object.assign(window,{TapraAndroid:{isNativeApp:()=>true,isLocationPermissionGranted:()=>native!=="denied",isPreciseLocationPermissionGranted:()=>native!=="approximate",getLocationServiceState:()=>native==="off"?"disabled":"enabled",setAuthenticatedUser:()=>{},setTrackingActive:()=>{},openLocationSettings:()=>{}}});
  },{native});
  await install(page,"employee",workflowState());
  const posts:Record<string,unknown>[]=[];
  await page.route("**/api/work-sessions",route=>{
    if(route.request().method()==="POST") {
      const body=route.request().postDataJSON();posts.push(body);
      return route.fulfill({status:201,contentType:"application/json",body:JSON.stringify({session:{id:body.clientSessionId,status:"active",startedAt:new Date().toISOString()}})});
    }
    return route.fulfill({contentType:"application/json",body:JSON.stringify({current:null,today:{activeSeconds:0,activeMinutes:0,unverifiedGpsMinutes:0,pendingCorrectionMinutes:0,firstStartAt:null,lastEndAt:null}})});
  });
  let origin=baseURL;
  if(native && native!=="http") {
    origin="https://gps-test.invalid";
    await page.route("https://gps-test.invalid/**",async route=>{
      const url=new URL(route.request().url());
      if(url.pathname.startsWith("/api/")) return route.fallback();
      const response=await route.fetch({url:`${baseURL}${url.pathname}${url.search}`});
      await route.fulfill({response});
    });
  }
  await page.goto(`${origin}/?panel=employee&screen=home`);
  const start=page.locator(".work-toggle"); await expect(start).toBeEnabled();
  const deliver=(accuracy:number,age=0,index=0)=>page.evaluate(({accuracy,age,index})=>{
    (window as unknown as GpsHarnessWindow).gpsTest.success[index]({timestamp:Date.now()-age,coords:{latitude:35.7,longitude:51.4,accuracy,altitude:null,altitudeAccuracy:null,heading:null,speed:null}} as GeolocationPosition);
  },{accuracy,age,index});
  return {posts,start,deliver};
}

test("GPS H/I: absent callbacks time out, unlock Retry and ignore late success/error",async({page,baseURL})=>{
  const h=await workStartIncident(page,baseURL!); await h.start.click();
  await expect(h.start).toBeDisabled(); await expect(page.locator(".work-gps-feedback")).toContainText("۲۵ ثانیه");
  await page.clock.fastForward(25_001);
  await expect(h.start).toBeEnabled(); await expect(h.start).toContainText("شروع فعالیت");
  await expect(page.locator(".work-gps-feedback")).toContainText("در مهلت تعیین‌شده");
  await h.deliver(49);
  await page.evaluate(()=>(window as unknown as GpsHarnessWindow).gpsTest.errors[0]({code:1,message:"late"} as GeolocationPositionError));
  expect(h.posts).toHaveLength(0); await expect(h.start).toContainText("شروع فعالیت");
  expect(await page.evaluate(()=>(window as unknown as GpsHarnessWindow).gpsTest.cleared)).toContain(1);
  await h.start.click(); await h.deliver(49,0,1);
  await expect(h.start).toContainText("پایان فعالیت"); expect(h.posts).toHaveLength(1);
});
test("GPS B/C: 101m explains accuracy, expires safely; retry at 100m starts once",async({page,baseURL})=>{
  const h=await workStartIncident(page,baseURL!); await h.start.click(); await h.deliver(101);
  await expect(page.locator(".work-gps-feedback")).toContainText("۱۰۱");
  expect(h.posts).toHaveLength(0); await page.clock.fastForward(25_001);
  await expect(h.start).toBeEnabled(); await expect(page.locator(".work-gps-feedback")).toContainText("دقت GPS به ۱۰۰ متر نرسید");
  await h.start.click(); await h.deliver(100,0,1);
  await expect(h.start).toContainText("پایان فعالیت"); expect(h.posts).toHaveLength(1);
});

test("logout cancels an in-flight acquisition before logout network acknowledgement",async({page,baseURL})=>{
  const h=await workStartIncident(page,baseURL!); await h.start.click();
  await page.route("**/api/auth/logout",()=>{});
  await page.getByRole("button",{name:"پروفایل",exact:true}).click();
  await page.locator(".logout").click();
  await h.deliver(49);
  expect(h.posts).toHaveLength(0);
  expect(await page.evaluate(()=>(window as unknown as GpsHarnessWindow).gpsTest.cleared)).toContain(1);
});
for(const [code,message] of [[1,"مجوز موقعیت مسدود"],[2,"سرویس مکان‌یابی موقعیت را در دسترس قرار نداد"],[3,"در مهلت تعیین‌شده"]] as const) {
  test(`GPS error ${code} immediately unlocks work-start and reports its reason`,async({page,baseURL})=>{
    const h=await workStartIncident(page,baseURL!); await h.start.click();
    await page.evaluate(code=>(window as unknown as GpsHarnessWindow).gpsTest.errors[0]({code,message:"synthetic"} as GeolocationPositionError),code);
    await expect(h.start).toBeEnabled(); await expect(page.locator(".work-gps-feedback")).toContainText(message); expect(h.posts).toHaveLength(0);
  });
}
for(const [native,message] of [["approximate","Precise Location"],["denied","مجوز موقعیت مسدود"],["off","موقعیت مکانی گوشی خاموش"],["http","HTTPS"]] as const) {
  test(`native GPS preflight ${native} fails fast without starting a watch/session`,async({page,baseURL})=>{
    const h=await workStartIncident(page,baseURL!,native); await h.start.click();
    await expect(h.start).toBeEnabled(); await expect(page.locator(".work-gps-feedback")).toContainText(message);
    expect(await page.evaluate(()=>(window as unknown as GpsHarnessWindow).gpsTest.success.length)).toBe(0); expect(h.posts).toHaveLength(0);
  });
}
test("hung start response uses a separate bounded state and retries the SAME session id",async({page,baseURL})=>{
  const h=await workStartIncident(page,baseURL!); const attempts:string[]=[];
  await page.route("**/api/work-sessions",async route=>{
    if(route.request().method()!=="POST") return route.fallback();
    const body=route.request().postDataJSON(); attempts.push(body.clientSessionId);
    if(attempts.length===1) return; // No response, even though GPS acquisition succeeded.
    return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({session:{id:body.clientSessionId,status:"active",startedAt:new Date().toISOString()}})});
  });
  await h.start.click(); await h.deliver(49);
  await expect(h.start).toContainText("در حال ثبت فعالیت"); await expect.poll(()=>attempts.length).toBe(1);
  await page.clock.fastForward(15_001); await expect(h.start).toBeEnabled();
  await expect(page.getByText(/پاسخ ثبت فعالیت نرسید/)).toBeVisible();
  await h.start.click(); await h.deliver(49,0,1); await expect(h.start).toContainText("پایان فعالیت");
  expect(attempts).toHaveLength(2); expect(attempts[1]).toBe(attempts[0]);
});

test("fresh precise 49m GPS starts exactly one work session and enters the active state",async({page,context})=>{
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({latitude:35.7,longitude:51.4,accuracy:49});
  await install(page,"employee",workflowState());
  const posts:Record<string,unknown>[]=[];
  const startedAt=new Date().toISOString();
  await page.route("**/api/work-sessions",async route=>{
    if(route.request().method()==="POST"){
      const body=route.request().postDataJSON() as Record<string,unknown>;posts.push(body);
      return route.fulfill({status:201,contentType:"application/json",body:JSON.stringify({session:{id:"session-gps-49",status:"active",startedAt,workType:"regular"}})});
    }
    return route.fulfill({contentType:"application/json",body:JSON.stringify({current:null,today:{activeSeconds:0,activeMinutes:0,unverifiedGpsMinutes:0,pendingCorrectionMinutes:0,firstStartAt:null,lastEndAt:null}})});
  });
  await page.goto("/?panel=employee&screen=home");
  const start=page.locator(".work-toggle");
  await expect(start).toBeEnabled();
  await start.evaluate(button=>{
    button.dispatchEvent(new MouseEvent("click",{bubbles:true}));
    button.dispatchEvent(new MouseEvent("click",{bubbles:true}));
  });
  await expect(page.locator(".work-toggle")).toContainText("پایان فعالیت");
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({action:"start"});
  expect(posts[0].clientSessionId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(posts[0].location).toMatchObject({latitude:35.7,longitude:51.4,accuracy:49});
  expect(Number.isFinite(Date.parse(String((posts[0].location as Record<string,unknown>).recordedAt)))).toBe(true);
});

test("stale accurate GPS is not submitted; a fresh fix from the same start attempt succeeds",async({page})=>{
  await page.addInitScript(()=>{
    Object.defineProperty(navigator,"geolocation",{configurable:true,value:{
      watchPosition:(success:PositionCallback)=>{(window as unknown as {gpsSuccess?:PositionCallback}).gpsSuccess=success;return 17},
      clearWatch:()=>{},
    }});
  });
  await install(page,"employee",workflowState());
  const posts:Record<string,unknown>[]=[];
  const startedAt=new Date().toISOString();
  await page.route("**/api/work-sessions",async route=>{
    if(route.request().method()==="POST"){
      const body=route.request().postDataJSON() as Record<string,unknown>;posts.push(body);
      return route.fulfill({status:201,contentType:"application/json",body:JSON.stringify({session:{id:"session-fresh-after-stale",status:"active",startedAt,workType:"regular"}})});
    }
    return route.fulfill({contentType:"application/json",body:JSON.stringify({current:null,today:{activeSeconds:0,activeMinutes:0,unverifiedGpsMinutes:0,pendingCorrectionMinutes:0,firstStartAt:null,lastEndAt:null}})});
  });
  await page.goto("/?panel=employee&screen=home");
  await page.locator(".work-toggle").click();
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {gpsSuccess?:PositionCallback}).gpsSuccess!==undefined)).toBe(true);
  const deliver=(timestamp:number)=>page.evaluate((when)=>{
    const success=(window as unknown as {gpsSuccess?:PositionCallback}).gpsSuccess;
    success?.({coords:{latitude:35.7,longitude:51.4,accuracy:49,altitude:null,altitudeAccuracy:null,heading:null,speed:null},timestamp:when} as GeolocationPosition);
  },timestamp);
  await deliver(Date.now()-3*60_000);
  await expect(page.locator(".work-gps-feedback")).toContainText("موقعیت قبلی قدیمی است");
  expect(posts).toHaveLength(0);
  await deliver(Date.now());
  await expect(page.locator(".work-toggle")).toContainText("پایان فعالیت");
  expect(posts).toHaveLength(1);
  expect((posts[0].location as Record<string,unknown>).accuracy).toBe(49);
});

test("an active-session 409 recovers authoritative session instead of starting a second one",async({page,context})=>{
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({latitude:35.7,longitude:51.4,accuracy:49});
  await install(page,"employee",workflowState());
  const startedAt=new Date().toISOString();let posts=0;
  await page.route("**/api/work-sessions",async route=>{
    if(route.request().method()==="POST"){
      posts+=1;
      return route.fulfill({status:409,contentType:"application/json",body:JSON.stringify({code:"ACTIVE_WORK_SESSION_EXISTS",error:"یک فعالیت باز وجود دارد",session:{id:"existing-session",status:"active",startedAt}})});
    }
    return route.fulfill({contentType:"application/json",body:JSON.stringify({current:posts?{id:"existing-session",status:"active",startedAt,endedAt:null,workType:"regular"}:null,today:{activeSeconds:posts?30:0,activeMinutes:posts?1:0,unverifiedGpsMinutes:0,pendingCorrectionMinutes:0,firstStartAt:posts?startedAt:null,lastEndAt:null}})});
  });
  await page.goto("/?panel=employee&screen=home");
  await page.locator(".work-toggle").click();
  await expect(page.locator(".work-toggle")).toContainText("پایان فعالیت");
  await expect(page.getByText("فعالیت باز شما از سرور بازیابی شد؛ فعالیت دیگری ساخته نشد.")).toBeVisible();
  expect(posts).toBe(1);
});

test("notification failure does not prevent restoring the active work-session card",async({page})=>{
  const state=workflowState();state.notificationFailure=true;await install(page,"employee",state);
  const startedAt=new Date().toISOString();
  await page.route("**/api/work-sessions",route=>route.fulfill({contentType:"application/json",body:JSON.stringify({current:{id:"existing-session",status:"active",startedAt,endedAt:null,workType:"regular"},today:{activeSeconds:120,activeMinutes:2,unverifiedGpsMinutes:0,pendingCorrectionMinutes:0,firstStartAt:startedAt,lastEndAt:null}})}));
  await page.goto("/?panel=employee&screen=home");
  await expect(page.locator(".work-toggle")).toContainText("پایان فعالیت");
  await expect(page.locator(".timer")).not.toHaveText("۰:۰۰");
});

test("incomplete notification counts neither crash employee UI nor hide an active session",async({page})=>{
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await install(page,"employee",workflowState());
  await page.route("**/api/notifications",route=>route.fulfill({contentType:"application/json",body:"{}"}));
  const startedAt=new Date().toISOString();
  await page.route("**/api/work-sessions",route=>route.fulfill({contentType:"application/json",body:JSON.stringify({current:{id:"existing-session",status:"active",startedAt,endedAt:null,workType:"regular"},today:{activeSeconds:120,activeMinutes:2,unverifiedGpsMinutes:0,pendingCorrectionMinutes:0,firstStartAt:startedAt,lastEndAt:null}})}));
  await page.goto("/?panel=employee&screen=home");
  await expect(page.locator(".work-toggle")).toContainText("پایان فعالیت");
  expect(errors).toEqual([]);
});

test("continuing an arrived second stage preserves arrival and selects that stage's result",async({page})=>{
  const {mutations}=await focusedMission(page,{arrived:true,staged:true});
  await page.locator(".mission-main-action").click();
  await expect(page.locator(".work-flow .mission-current-step")).toContainText("مقصد دوم");
  await expect(page.getByRole("heading",{name:"نتیجه کار چه بود؟",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"→ بازگشت به همین مأموریت",exact:true}).click();
  await expect(page.locator(".mission-main-action")).toHaveText("ثبت نتیجه این مأموریت");
  expect(mutations).toEqual([]);
});
