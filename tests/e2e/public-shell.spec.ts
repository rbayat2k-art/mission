import { expect, test } from "@playwright/test";
import axe from "axe-core";

test("employee and management login shells are reachable and remain RTL", async ({ page }) => {
  const response = await page.goto("/?panel=employee&screen=home");
  expect(response?.ok()).toBeTruthy();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { name:"ورود به پنل کارمند" })).toBeVisible();

  await page.getByRole("tab", { name:/پنل مدیر/ }).click();
  await expect(page.getByRole("heading", { name:"ورود به پنل ادمین" })).toBeVisible();
  await expect(page).toHaveURL(/panel=admin/);
});

test("mobile login has no page-level horizontal overflow", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("android"), "mobile-only assertion");
  await page.goto("/?panel=employee&screen=home");
  await expect(page.getByRole("heading", { name:"ورود به پنل کارمند" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(2);
});

test("public pages return baseline browser security headers", async ({ request }) => {
  const response = await request.get("/");
  expect(response.ok()).toBeTruthy();
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["x-frame-options"]).toBe("SAMEORIGIN");
  expect(response.headers()["referrer-policy"]).toBeTruthy();
  expect(response.headers()["strict-transport-security"]).toContain("max-age=31536000");
  expect(response.headers()["cross-origin-opener-policy"]).toBe("same-origin");
});

test("login shells have no serious or critical automated accessibility violations", async ({ page }) => {
  await page.goto("/?panel=employee&screen=home");
  await page.addScriptTag({ content:axe.source });
  const violations = await page.evaluate(async () => {
    const result = await (window as typeof window & { axe:{ run:(root:Document, options:unknown)=>Promise<{violations:Array<{id:string;impact:string|null}>}> } }).axe.run(document, {});
    return result.violations.filter(item => item.impact === "critical" || item.impact === "serious");
  });
  expect(violations).toEqual([]);
});
