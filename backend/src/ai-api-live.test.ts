import { describe, expect, it, mock } from "bun:test";

const hasRequiredEnv =
  Boolean(Bun.env.DATABASE_URL) &&
  Boolean(Bun.env.CLERK_SECRET_KEY) &&
  Boolean(Bun.env.CLERK_PUBLISHABLE_KEY) &&
  Boolean(Bun.env.OPENROUTER_API_KEY);

const liveIt = hasRequiredEnv ? it : it.skip;

describe("ai api live", () => {
  liveIt(
    "creates a session and gets a non-empty live turn with mocked auth",
    async () => {
      mock.module("./auth", () => ({
        authenticateUserRequest: async () => ({
          userId: "test-user-live-ai",
        }),
      }));

      const { handleHttpRequest } = await import("./server");

      const sessionResponse = await handleHttpRequest(
        new Request("http://localhost/ai/session", {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            recentLogs: [],
          }),
        }),
      );

      expect(sessionResponse.status).toBe(200);
      const sessionPayload = (await sessionResponse.json()) as {
        sessionId?: string;
      };
      expect(typeof sessionPayload.sessionId).toBe("string");
      expect(sessionPayload.sessionId?.length).toBeGreaterThan(0);

      const turnResponse = await handleHttpRequest(
        new Request("http://localhost/ai/turn", {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify({
            sessionId: sessionPayload.sessionId,
            action: {
              type: "user-message",
              message: "Reply with exactly: live ai ok",
            },
          }),
        }),
      );

      expect(turnResponse.status).toBe(200);
      const turnBody = await turnResponse.text();

      expect(turnBody).toContain(`"type":"status"`);
      expect(turnBody).toContain(`"status":"ready"`);
      expect(turnBody).toContain(`"kind":"assistant"`);
      expect(turnBody.toLowerCase()).toContain("live ai ok");
    },
    30_000,
  );
});
