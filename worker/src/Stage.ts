// Deploy-time settings from the environment (the `deploy:*` scripts set them).
// Only meaningful while deploying; inside the running Worker they're unset.
const env = globalThis.process?.env ?? {};

export const isProduction = env.ALCHEMY_STAGE === "prod";

// Custom domain to attach. Production uses backend/'s hostname so the iOS app
// needs no update; `deploy:prod:staged` leaves it off (workers.dev only).
export const customDomain = env.CUSTOM_DOMAIN || undefined;
