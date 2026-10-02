import { expect, test } from "bun:test";

test("auth trusts both production hosts but rejects lookalike origins", async () => {
  // Isolate config from the developer's environment and other tests. No real
  // session is supplied, so sign-out exercises CSRF without database access.
  const child = Bun.spawn([process.execPath, "-e", `
    import assert from "node:assert/strict";
    const { auth } = await import("./auth.ts");
    for (const host of ["https://caloric.mati.lol", "https://backend.caloric.mati.lol"]) {
      for (const [origin, status, payload] of [
        ["https://caloric.mati.lol", 200, { success: true }],
        ["https://backend.caloric.mati.lol", 200, { success: true }],
        ["https://caloric.mati.lol.evil.example", 403, { message: "Invalid origin", code: "INVALID_ORIGIN" }],
        ["http://caloric.mati.lol", 403, { message: "Invalid origin", code: "INVALID_ORIGIN" }],
      ]) {
        const response = await auth.handler(new Request(host + "/api/auth/sign-out", {
          method: "POST",
          // A cookie is necessary to exercise Better Auth's origin check.
          headers: { origin, cookie: "test=1", "content-type": "application/json" },
          body: "{}",
        }));
        assert.equal(response.status, status, host + " from " + origin);
        assert.deepEqual(await response.json(), payload);
      }
    }
  `], {
    cwd: new URL("./", import.meta.url).pathname,
    env: {
      NODE_ENV: "production",
      DATABASE_URL: "postgres://test:test@127.0.0.1:1/test",
      BETTER_AUTH_SECRET: "local-test-secret-not-used-in-production",
      BETTER_AUTH_URL: "https://backend.caloric.mati.lol",
      AUTH_TRUSTED_ORIGINS: "",
      WEB_ORIGINS: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, output + error).toBe(0);
});
