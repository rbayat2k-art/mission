import { expect, test, type Page } from "@playwright/test";
import { deflateSync } from "node:zlib";

// Large, synthetic PNG fixture: no employee photo, filesystem input or network.
function fixturePng() {
  const width=640,height=400;
  const chunk=(name:string, data:Buffer)=>{
    const payload=Buffer.concat([Buffer.from(name),data]);
    let crc=0xffffffff;
    for(const value of payload){crc^=value;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}
    const length=Buffer.alloc(4);length.writeUInt32BE(data.length);
    const checksum=Buffer.alloc(4);checksum.writeUInt32BE((crc^0xffffffff)>>>0);
    return Buffer.concat([length,payload,checksum]);
  };
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const pixels=Buffer.alloc((1+width*3)*height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const index=y*(1+width*3)+1+x*3;
    const color=y<90?[45,90,200]:(x>40&&x<600&&y%70<22)?[180,205,230]:[240,245,250];
    pixels.set(color,index);
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(pixels)),chunk("IEND",Buffer.alloc(0))]);
}
const png=fixturePng();
const attachment = (id = "image-a") => ({ id, fileName:`${id}.png`, contentType:"image/png", uploadedByRole:"admin", uploadedByName:"مدیر آزمایشی", sizeBytes:png.length });

async function setup(page: Page) {
  const mutations: string[] = [];
  await page.addInitScript(() => {
    // Native bridge shape only: physical WebView and Android watchdog are separate tests.
    Object.assign(window, { TapraAndroid:{isNativeApp:()=>true,setAuthenticatedUser:()=>{},setTrackingActive:()=>{},isBatteryOptimizationExempt:()=>true} });
  });
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({contentType:"application/json",body:JSON.stringify(body)});
    if (route.request().method() !== "GET") mutations.push(path);
    if (path === "/api/auth/me") return json({user:{id:"employee-fixture",role:"employee",fullName:"کارمند آزمایشی",username:"fixture",mustChangePassword:false,notificationEnabled:false}});
    if (path === "/api/missions") return json({missions:["a","b"].map(id => ({id:`mission-${id}`,title:`مأموریت آزمایشی ${id}`,status:"open",source:"admin",priority:"normal",createdAt:"2026-09-09T08:00:00Z",description:"راهنمای آزمایشی",workflowType:"single",scoreConfirmed:0,scorePending:0}))});
    if (path === "/api/work-sessions") return json({current:null,today:{activeSeconds:0,activeMinutes:0,unverifiedGpsMinutes:0,pendingCorrectionMinutes:0,firstStartAt:null,lastEndAt:null}});
    if (path === "/api/attachments") return json({attachments:[attachment(new URL(route.request().url()).searchParams.get("missionId") === "mission-b" ? "image-b" : "image-a")]});
    if (path.startsWith("/api/attachments/")) return route.fulfill({contentType:"image/png",body:png,headers:{"Cache-Control":"private, no-store"}});
    return json({events:[],notifications:[],unreadCount:0,openRequestCount:0});
  });
  await page.goto("/?panel=employee&screen=missions");
  await page.getByRole("heading",{name:"مأموریت آزمایشی a",exact:true}).click();
  await expect(page.getByRole("link",{name:/image-a.png/})).toBeVisible();
  return mutations;
}

test("protected mission image opens inside the app, closes accessibly, and makes no mutations", async ({ page, context }, info) => {
  const mutations = await setup(page);
  const before = page.url();
  const requests: string[] = [];
  page.on("request",request=>{if(request.url().endsWith("/api/attachments/image-a") && request.resourceType()==="fetch") requests.push(request.headers()["x-tapra-user-id"])});
  await page.getByRole("link",{name:/image-a.png/}).click();
  const dialog = page.getByRole("dialog",{name:"نمایش تصویر مأموریت"});
  await expect(dialog.getByRole("img")).toBeVisible();
  await expect.poll(()=>dialog.getByRole("img").evaluate((element: HTMLImageElement)=>element.naturalWidth)).toBeGreaterThan(0);
  expect(requests).toEqual(["employee-fixture"]);
  expect(page.url()).toBe(before);
  expect(context.pages()).toHaveLength(1);
  expect(mutations).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(2);
  await page.screenshot({path:info.outputPath("mission-image-preview.png")});
  await dialog.getByRole("button",{name:"نمایش اندازه اصلی"}).click();
  await expect(dialog.getByRole("button",{name:"متناسب با صفحه"})).toHaveAttribute("aria-pressed","true");
  await dialog.getByRole("button",{name:"بستن تصویر"}).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("link",{name:/image-a.png/})).toBeFocused();
});

test("an invalid image shows an explicit decoding error, not a blank app", async ({page}) => {
  await setup(page);
  await page.route("**/api/attachments/image-a",route=>route.fulfill({contentType:"image/png",body:"not-a-png"}));
  await page.getByRole("link",{name:/image-a.png/}).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("تصویر خوانا نیست");
});

test("a stalled image request times out and can be closed without navigating", async ({page}) => {
  await setup(page);
  await page.clock.install();
  let seen=false;
  await page.route("**/api/attachments/image-a",()=>{seen=true});
  await page.getByRole("link",{name:/image-a.png/}).click();
  await expect.poll(()=>seen).toBe(true);
  await page.clock.fastForward(15_001);
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("دریافت تصویر طول کشید");
  await page.getByRole("button",{name:"بستن تصویر"}).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

for (const status of [401,403,404,500]) {
  test(`image HTTP ${status} stays in-app, displays a safe error and allows manual retry`, async ({page}) => {
    await setup(page);
    await page.route("**/api/attachments/image-a", route=>route.fulfill({status,contentType:"application/json",body:'{"error":"private-debug-must-not-appear"}'}));
    await page.getByRole("link",{name:/image-a.png/}).click();
    const dialog=page.getByRole("dialog");
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(dialog).not.toContainText("private-debug");
    await page.unroute("**/api/attachments/image-a");
    await dialog.getByRole("button",{name:"تلاش دوباره"}).click();
    await expect(dialog.getByRole("img")).toBeVisible();
  });
}

test("offline image request preserves the page and retry works after connection returns", async ({page,context}) => {
  await setup(page);
  await context.setOffline(true);
  // Abort simulates the failed transport: routed fixtures otherwise ignore offline mode.
  await page.route("**/api/attachments/image-a", route=>route.abort("internetdisconnected"));
  await page.getByRole("link",{name:/image-a.png/}).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
  await context.setOffline(false);
  await page.unroute("**/api/attachments/image-a");
  await page.getByRole("button",{name:"تلاش دوباره"}).click();
  await expect(page.getByRole("dialog").getByRole("img")).toBeVisible();
});

test("changing missions cancels the old list request and cannot display its photos", async ({page}) => {
  await setup(page);
  await page.getByRole("button",{name:"→ بازگشت",exact:true}).click();
  let release!: () => void;
  const waiting = new Promise<void>(resolve => {release=resolve});
  let seen = false;
  await page.route("**/api/attachments?missionId=mission-a",async route=>{seen=true;await waiting;await route.fulfill({contentType:"application/json",body:JSON.stringify({attachments:[attachment("obsolete")]})}).catch(()=>{})});
  await page.getByRole("heading",{name:"مأموریت آزمایشی a",exact:true}).click();
  await expect.poll(()=>seen).toBe(true);
  await page.getByRole("button",{name:"→ بازگشت",exact:true}).click();
  await page.getByRole("heading",{name:"مأموریت آزمایشی b",exact:true}).click();
  await expect(page.getByRole("link",{name:/image-b.png/})).toBeVisible();
  release();
  await expect(page.getByRole("link",{name:/obsolete/})).toHaveCount(0);
});
