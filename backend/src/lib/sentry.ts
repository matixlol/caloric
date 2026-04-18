import * as Sentry from "@sentry/bun";

const SENTRY_DSN =
  "https://4d312c3af94cd2789193ccb90c4fd2e7@o4510397347987456.ingest.us.sentry.io/4511169851686912";

export const SENTRY_ENABLE_LOGS = true;
export const SENTRY_TRACES_SAMPLE_RATE = 1;
export const SENTRY_SERVICE_NAME = "caloric-backend";

let initialized = false;

export function initSentry(): void {
  if (initialized || Sentry.isInitialized()) {
    initialized = true;
    return;
  }

  Sentry.init({
    dsn: SENTRY_DSN,
    enabled: true,
    enableLogs: SENTRY_ENABLE_LOGS,
    tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE,
    integrations: [Sentry.bunServerIntegration()],
    initialScope: {
      tags: {
        service: SENTRY_SERVICE_NAME,
      },
    },
  });

  initialized = true;
}

export { Sentry };
