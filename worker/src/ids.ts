import { typeid } from "typeid-js";

// Time-sortable, prefixed ids (same formats backend/ issued).
const make = (prefix: string) => () => typeid(prefix).toString();

export const aiSessionId = make("ai_session");
export const aiMessageId = make("ai_message");
export const aiTurnId = make("ai_turn");
export const mfpTraceId = make("mfp_trace");
export const friendshipId = make("friendship");
