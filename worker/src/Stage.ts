// The deploy target, from ALCHEMY_STAGE (the `deploy:*` scripts set it). Only
// meaningful at deploy time; inside the running Worker it is always false.
export const stage = globalThis.process?.env?.ALCHEMY_STAGE;
export const isProduction = stage === "prod";

// Production keeps backend/'s hostname so the iOS app needs no update.
export const PRODUCTION_DOMAIN = "backend.caloric.mati.lol";
