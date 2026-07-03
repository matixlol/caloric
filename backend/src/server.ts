import { httpInstrumentationMiddleware } from "@hono/otel";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./auth";
import { config } from "./config";
import { SENTRY_ENABLE_LOGS, SENTRY_SERVICE_NAME, SENTRY_TRACES_SAMPLE_RATE, Sentry } from "./lib/sentry";
import { logInfo, redactSecret } from "./logging";
import { MFP_BASE_URL } from "./providers/myfitnesspal/session";
import { aiRoutes } from "./routes/ai";
import { healthRoutes } from "./routes/health";
import { myFitnessPalRoutes } from "./routes/myfitnesspal";
import { searchRoutes } from "./routes/search";
import { socialRoutes } from "./services/social";
import { syncRoutes } from "./routes/sync";

export const app = new Hono();

app.use(
  "*",
  httpInstrumentationMiddleware({
    serviceName: SENTRY_SERVICE_NAME,
    captureRequestHeaders: ["content-type", "user-agent"],
    captureResponseHeaders: ["content-type"],
  }),
);

// Browser (web build) cross-origin credentialed requests. Native clients send
// no Origin header and ignore CORS, so this only affects the web app.
if (config.webOrigins.length > 0) {
  app.use(
    "*",
    cors({
      origin: config.webOrigins,
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      credentials: true,
    }),
  );
}

// Better Auth owns everything under /api/auth (sign-in, email OTP, session).
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.route("/", healthRoutes);
app.route("/ai", aiRoutes);
app.route("/mfp", myFitnessPalRoutes);
app.route("/search", searchRoutes);
app.route("/social", socialRoutes);
app.route("/sync", syncRoutes);

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((error, c) => {
  Sentry.captureException(error, {
    mechanism: {
      type: "auto.middleware.hono",
      handled: false,
    },
  });

  return c.json({ error: "Internal server error" }, 500);
});

export async function handleHttpRequest(request: Request): Promise<Response> {
  return app.fetch(request);
}

if (import.meta.main) {
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: config.port,
    idleTimeout: 120,
    fetch: app.fetch,
  });

  logInfo("backend.startup", {
    host: server.hostname,
    port: server.port,
    mfpBaseUrl: MFP_BASE_URL,
    hasMfpUsername: Boolean(config.mfpUsername),
    hasMfpPassword: Boolean(config.mfpPassword),
    hasTwoCaptchaApiKey: Boolean(config.twoCaptchaApiKey),
    mfpUsernamePreview: redactSecret(config.mfpUsername),
    mfpDetailConcurrency: config.detailConcurrency,
    mfpRequestTimeoutMs: config.requestTimeoutMs,
    sentryEnabled: true,
    sentryEnableLogs: SENTRY_ENABLE_LOGS,
    sentryTracesSampleRate: SENTRY_TRACES_SAMPLE_RATE,
    sentryServiceName: SENTRY_SERVICE_NAME,
  });
}
