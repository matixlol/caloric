import "react-native-get-random-values";
import { typeid } from "typeid-js";

export function createTimestampedTypeId(type: string): string {
  return typeid(type).toString();
}

export function createFoodEntryId(): string {
  return createTimestampedTypeId("food_entry");
}

export function createAiMessageId(): string {
  return createTimestampedTypeId("ai_message");
}
