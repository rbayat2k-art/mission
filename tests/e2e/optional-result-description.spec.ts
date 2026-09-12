import { expect, test, type Page } from "@playwright/test";

// Browser-only regression: every API request and GPS position is synthetic.
// No authenticated service, database or production endpoint is used.
test.use({ serviceWorkers:"block" });

type Workflow = "single" | "multi_stage" | "task_list";
type Completion = {result:string;report:string;requestSupervisorAction:boolean;followUpCategory:string;expenseAmount:number;endLocation:{latitude:number;longitude:number;accuracy:number;recordedAt:string}};
type TaskResult = {result:string;report:string;expectedVersion:number;clientEventId:string;location:{latitude:number;longitude:number;accuracy:number}};

async function openResult(page:Page,workflowType:Workflow="single") {
  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation({latitude:35,longitude:51,accuracy:5});
  const now=new Date().toISOString();
  const mission={
    id:"optional-report-mission",title:"مأموریت نتیجه اختیاری آزمایشی",description:"بررسی مدارک آزمایشی",
    status:"in_progress",source:"manager",priority:"normal",workflowType,createdAt:now,startedAt:now,
    destinationName:"مقصد آزمایشی",destinationRegisteredAt:now,scoreConfirmed:0,scorePending:0,
    currentStepNo:workflowType==="multi_stage"?2:1,
    steps:workflowType==="multi_stage"?[1,2].map(stepNo=>({
      id:`step-${stepNo}`,stepNo,title:`مرحله آزمایشی ${stepNo}`,actionType:"visit",description:"",
      status:stepNo===1?"completed":"arrived",requiresLocation:true,startedAt:now,arrivedAt:now,
      destinationName:"مقصد آزمایشی",evidenceRequirement:"none",deadline:null,deadlineAt:null,
    })):[],
    tasks:workflowType==="task_list"?[1,2].map(taskNo=>({
      id:`task-${taskNo}`,taskNo,title:`کار آزمایشی ${taskNo}`,description:"",status:"open",
      result:null as string|null,report:null as string|null,version:1,
    })):[],
  };
  const completions:Completion[]=[];
  const taskResults:TaskResult[]=[];
  const mutations:string[]=[];
  await page.route("**/api/**",route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    const json=(body:unknown)=>route.fulfill({contentType:"application/json",body:JSON.stringify(body)});
    if(request.method()!=="GET")mutations.push(path);
    if(path==="/api/auth/me")return json({user:{id:"employee-fixture",role:"employee",fullName:"کارمند آزمایشی",username:"fixture",mustChangePassword:false,notificationEnabled:false}});
    if(path==="/api/missions")return json({missions:[mission]});
    if(path==="/api/work-sessions")return json({current:{id:"session-fixture",startedAt:now,endedAt:null},today:{activeSeconds:30,activeMinutes:0,unverifiedGpsMinutes:0,pendingCorrectionMinutes:0,firstStartAt:now,lastEndAt:null}});
    if(path==="/api/attachments")return json({attachments:[]});
    if(path===`/api/missions/${mission.id}/complete`){
      expect(request.method()).toBe("POST");
      expect(request.headers()["x-tapra-user-id"]).toBe("employee-fixture");
      const body=request.postDataJSON() as Completion;
      completions.push(body);
      mission.status=body.result==="انجام شد"?"approved":"follow_up";
      return json({mission:{status:mission.status,needsFollowUp:body.result!=="انجام شد",requestSupervisorAction:body.requestSupervisorAction,scoreConfirmed:12,scorePending:0,scorePenalty:0,scoreNote:null,completedWithoutStart:false,hasNextStep:false}});
    }
    if(path.startsWith(`/api/missions/${mission.id}/tasks/`)){
      expect(request.method()).toBe("PATCH");
      expect(request.headers()["x-tapra-user-id"]).toBe("employee-fixture");
      const body=request.postDataJSON() as TaskResult;
      taskResults.push(body);
      const task=mission.tasks.find(item=>path.endsWith(`/${item.id}`));
      expect(task).toBeDefined();
      Object.assign(task!,{status:body.result==="انجام شد"?"completed":"follow_up",result:body.result,report:body.report.trim(),version:body.expectedVersion+1});
      return json({task});
    }
    return json({ok:true,autoEnded:false,events:[],notifications:[],unreadCount:0,openRequestCount:0});
  });
  await page.goto("/?panel=employee&screen=home");
  await expect(page.locator(".connection-row")).toContainText("GPS · دقت 5 متر");
  await page.getByRole("button",{name:/مأموریت‌ها/}).last().click();
  await page.locator(".mission-tabs").getByRole("button",{name:/در حال انجام/}).click();
  await page.getByRole("heading",{name:mission.title,exact:true}).click();
  await page.getByRole("button",{name:"ثبت نتیجه این مأموریت",exact:true}).click();
  await expect(page.getByRole("heading",{name:workflowType==="task_list"?"کارهای این مقصد":"نتیجه کار چه بود؟",exact:true})).toBeVisible();
  return {completions,taskResults,mutations};
}

async function submitReview(page:Page,supervisor=false) {
  await expect(page.getByRole("heading",{name:"مدارک و هزینه",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"مرور نهایی",exact:true}).click();
  await expect(page.getByRole("heading",{name:"مرور و ارسال گزارش",exact:true})).toBeVisible();
  await page.getByRole("button",{name:supervisor?"پایان مراجعه و ارجاع به سرپرست":"پایان مأموریت و ثبت گزارش",exact:true}).click();
  await expect(page.locator(".success-panel")).toBeVisible();
}

for(const result of ["انجام شد","نیاز به پیگیری","مسئول نبود","تعطیل بود","موکول شد","سایر"]) {
  test(`single mission accepts an empty description for ${result}, without implicit supervisor referral`,async({page})=>{
    const state=await openResult(page);
    const description=page.getByRole("textbox",{name:"توضیح نتیجه اختیاری",exact:true});
    const next=page.getByRole("button",{name:"ادامه",exact:true});
    await expect(description).not.toHaveAttribute("required");
    await expect(description).toHaveValue("");
    await expect(next).toBeDisabled();
    await description.fill("توضیح بدون انتخاب نتیجه");
    await expect(next).toBeDisabled();
    await description.fill("");
    await page.locator(".result-grid").getByRole("button",{name:result,exact:true}).click();
    await expect(description).toHaveValue("");
    if(result!=="انجام شد")await expect(page.getByRole("checkbox",{name:"ارجاع پیگیری به سرپرست"})).not.toBeChecked();
    await expect(next).toBeEnabled();
    await next.click();
    await submitReview(page);
    expect(state.completions).toHaveLength(1);
    expect(state.completions[0]).toMatchObject({result,report:"",requestSupervisorAction:false,expenseAmount:0,endLocation:{latitude:35,longitude:51,accuracy:5}});
    expect(state.mutations.filter(path=>path.includes("/start")||path==="/api/destinations")).toEqual([]);
  });
}

test("an arrived stage can be completed with an empty description",async({page})=>{
  const state=await openResult(page,"multi_stage");
  await expect(page.locator(".mission-current-step")).toContainText("مرحله آزمایشی 2");
  await page.locator(".result-grid").getByRole("button",{name:"انجام شد",exact:true}).click();
  await expect(page.getByRole("textbox",{name:"توضیح نتیجه اختیاری",exact:true})).toHaveValue("");
  await page.getByRole("button",{name:"ادامه",exact:true}).click();
  await submitReview(page);
  expect(state.completions).toHaveLength(1);
  expect(state.completions[0]).toMatchObject({result:"انجام شد",report:"",requestSupervisorAction:false});
});

test("explicit supervisor referral accepts whitespace-only description and keeps the selected category",async({page},info)=>{
  const state=await openResult(page);
  await page.locator(".result-grid").getByRole("button",{name:"سایر",exact:true}).click();
  const referral=page.getByRole("checkbox",{name:"ارجاع پیگیری به سرپرست"});
  await expect(referral).not.toBeChecked();
  await referral.check();
  await page.locator("#follow-up-category").selectOption("coordination");
  const description=page.getByRole("textbox",{name:"توضیح نتیجه اختیاری",exact:true});
  await expect(description).not.toHaveAttribute("required");
  await description.fill(" \n\t ");
  await expect(page.getByRole("button",{name:"ادامه",exact:true})).toBeEnabled();
  await description.blur();
  await page.getByRole("button",{name:"ادامه",exact:true}).scrollIntoViewIfNeeded();
  await expect(page.locator(".toast")).toBeHidden();
  await page.screenshot({path:info.outputPath("optional-result-supervisor-referral.png"),fullPage:true});
  await page.getByRole("button",{name:"ادامه",exact:true}).click();
  await page.getByRole("button",{name:"مرور نهایی",exact:true}).click();
  await expect(page.locator(".review-card")).toContainText("بدون توضیح");
  await page.getByRole("button",{name:"پایان مراجعه و ارجاع به سرپرست",exact:true}).click();
  await expect(page.getByRole("heading",{name:"درخواست برای سرپرست ارسال شد",exact:true})).toBeVisible();
  expect(state.completions).toHaveLength(1);
  expect(state.completions[0]).toMatchObject({result:"سایر",report:"",requestSupervisorAction:true,followUpCategory:"coordination"});
});

test("short employee text survives result changes and back navigation and is submitted verbatim after trimming",async({page})=>{
  const state=await openResult(page);
  await page.locator(".result-grid").getByRole("button",{name:"نیاز به پیگیری",exact:true}).click();
  const description=page.getByRole("textbox",{name:"توضیح نتیجه اختیاری",exact:true});
  await description.fill(" ن ");
  await page.locator(".result-grid").getByRole("button",{name:"سایر",exact:true}).click();
  await expect(description).toHaveValue(" ن ");
  await page.getByRole("button",{name:"ادامه",exact:true}).click();
  await page.getByRole("button",{name:"→ ویرایش مرحله قبل",exact:true}).click();
  await expect(description).toHaveValue(" ن ");
  await page.getByRole("button",{name:"ادامه",exact:true}).click();
  await submitReview(page);
  expect(state.completions).toHaveLength(1);
  expect(state.completions[0]).toMatchObject({result:"سایر",report:"ن",requestSupervisorAction:false});
});

test("individual unsuccessful and follow-up tasks allow blank descriptions but still require every task result",async({page})=>{
  const state=await openResult(page,"task_list");
  const continueList=page.getByRole("button",{name:"ادامه و مرور نهایی مأموریت",exact:true});
  for(const [index,result] of ["انجام نشد","نیاز به پیگیری"].entries()){
    await expect(page.locator(".task-checklist-items article.active")).toContainText(`کار آزمایشی ${index+1}`);
    await expect(continueList).toBeDisabled();
    await expect(page.getByRole("button",{name:"ثبت نتیجه این کار",exact:true})).toBeDisabled();
    const editor=page.locator(".task-result-editor");
    await editor.getByRole("button",{name:result,exact:true}).click();
    const description=editor.getByRole("textbox",{name:"توضیح اختیاری",exact:true});
    await expect(description).not.toHaveAttribute("required");
    await expect(description).toHaveValue("");
    await page.getByRole("button",{name:"ثبت نتیجه این کار",exact:true}).click();
    await expect.poll(()=>state.taskResults.length).toBe(index+1);
    expect(state.taskResults[index]).toMatchObject({result,report:"",expectedVersion:1,location:{latitude:35,longitude:51,accuracy:5}});
    expect(state.taskResults[index].clientEventId).toBeTruthy();
  }
  await expect(continueList).toBeEnabled();
  await continueList.click();
  await submitReview(page);
  expect(state.completions).toHaveLength(1);
  // This pre-existing structured task summary is not an invented employee explanation.
  expect(state.completions[0]).toMatchObject({result:"نیاز به پیگیری",report:"۱. کار آزمایشی 1: انجام نشد\n۲. کار آزمایشی 2: نیاز به پیگیری",requestSupervisorAction:false});
});
