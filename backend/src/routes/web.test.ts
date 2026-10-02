import { describe, expect, test } from "bun:test";
import { createWebRoutes } from "./web";

describe("backend web serving (run web:build first)", () => {
  test("serves the real authenticated client without a demo route", async () => {
    const app = createWebRoutes();
    const root = await app.request("/");
    expect(root.status).toBe(200);
    expect(root.headers.get("cache-control")).toBe("no-store");
    expect(await root.text()).toContain("/web/app.js");
    expect((await app.request("/demo")).status).toBe(404);
  });
  test("only public build assets are served, never sources or API fallbacks", async () => {
    const app = createWebRoutes();
    const script = await app.request("/web/app.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("javascript");
    expect(script.headers.get("x-content-type-options")).toBe("nosniff");
    expect(
      (await app.request("/web/app.css")).headers.get("content-type"),
    ).toContain("text/css");
    for (const path of [
      "/web/.env",
      "/web/server.ts",
      "/web/index.html",
      "/web/../../src/config.ts",
      "/sync/bootstrap",
      "/api/auth/get-session",
      "/unknown",
    ]) {
      expect((await app.request(path)).status).toBe(404);
    }
  });
});
