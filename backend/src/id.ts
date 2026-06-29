import { typeid } from "typeid-js";

export function createTimestampedTypeId(type: string): string {
  return typeid(type).toString();
}

export function createAiSessionId(): string {
  return createTimestampedTypeId("ai_session");
}

export function createAiMessageId(): string {
  return createTimestampedTypeId("ai_message");
}

export function createAiTurnId(): string {
  return createTimestampedTypeId("ai_turn");
}

export function createMfpTraceId(): string {
  return createTimestampedTypeId("mfp_trace");
}

export function createFriendshipId(): string {
  return createTimestampedTypeId("friendship");
}
