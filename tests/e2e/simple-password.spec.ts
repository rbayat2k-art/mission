import { expect, test } from "@playwright/test";
test.use({serviceWorkers:"block"});
test("four-character password submits without complexity requirement", async ({page}) => {
  let submitted: Record<string,unknown>|null=null;
  await page.route("**/api/**",async route=>{
    const path=new URL(route.request().url()).pathname;
    const json=(value:unknown)=>route.fulfill({contentType:"application/json",body:JSON.stringify(value)});
    if(path==="/api/auth/me")return json({user:{id:"fixture",role:"employee",fullName:"آزمایشی",username:"fixture",mustChangePassword:true}});
    if(path==="/api/auth/change-password") {submitted=route.request().postDataJSON();return json({user:{id:"fixture",role:"employee",fullName:"آزمایشی",mustChangePassword:false}});}
    return json({missions:[],notifications:[],current:null,today:{activeSeconds:0},ok:true});
  });
  await page.goto("/?panel=employee&screen=home");
  await expect(page.getByRole("heading",{name:"رمز موقت را تغییر دهید"})).toBeVisible();
  await page.getByPlaceholder("حداقل ۴ کاراکتر؛ حرف یا عدد یا ترکیب آن‌ها").fill("1234");
  await page.getByPlaceholder("رمز جدید را دوباره وارد کنید").fill("1234");
  await page.getByRole("button",{name:"ثبت رمز جدید و ادامه"}).click();
  await expect.poll(()=>submitted).toEqual({newPassword:"1234",confirmPassword:"1234"});
});
