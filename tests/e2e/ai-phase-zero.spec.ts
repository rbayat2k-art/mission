import { expect, test } from "@playwright/test";

test("AI advisory endpoint is private, no-store and rejects unauthenticated requests", async ({ request }) => {
  const response = await request.post("/api/insights/performance/ai", { data: { period: "daily" } });
  expect(response.status()).toBe(401);
  expect(response.headers()["cache-control"]).toContain("private");
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["vary"]).toContain("Cookie");
  await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
});
