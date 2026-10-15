import type { ModelMessage } from "ai";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { aiSessions } from "../db/schema";
import type { SearchResultFood } from "./search";

export const mealValues = ["breakfast", "lunch", "dinner", "snacks"] as const;
export type Meal = (typeof mealValues)[number];

export type ApprovalOutput = {
  approved: boolean;
  reason?: string;
};

export type ResolvedApprovalSuggestion = {
  suggestionId: string;
  resultId: string;
  meal: Meal;
  portion: number;
  reason: string;
  food: SearchResultFood;
  output?: ApprovalOutput;
};

export type AssistantVariant = "classic" | "next";

export type AiSessionState = {
  id: string;
  userId: string;
  variant: AssistantVariant;
  conversation: ModelMessage[];
  searchResultCounter: number;
  searchResultsByLocalId: Record<string, SearchResultFood>;
  pendingApprovals: Record<string, ResolvedApprovalSuggestion[]>;
};

export async function createAiSession(session: AiSessionState): Promise<void> {
  const now = new Date();

  await db.insert(aiSessions).values({
    id: session.id,
    userId: session.userId,
    conversation: session.conversation,
    searchResultCounter: session.searchResultCounter,
    searchResultsByLocalId: session.searchResultsByLocalId,
    pendingApprovals: session.pendingApprovals,
    variant: session.variant === "next" ? "next" : null,
    createdAt: now,
    updatedAt: now,
  });
}

export async function loadAiSession(sessionId: string, userId: string): Promise<AiSessionState | null> {
  const [session] = await db
    .select({
      id: aiSessions.id,
      userId: aiSessions.userId,
      conversation: aiSessions.conversation,
      searchResultCounter: aiSessions.searchResultCounter,
      searchResultsByLocalId: aiSessions.searchResultsByLocalId,
      pendingApprovals: aiSessions.pendingApprovals,
      variant: aiSessions.variant,
    })
    .from(aiSessions)
    .where(and(eq(aiSessions.id, sessionId), eq(aiSessions.userId, userId)))
    .limit(1);

  if (!session) {
    return null;
  }

  return {
    id: session.id,
    userId: session.userId,
    variant: session.variant === "next" ? "next" : "classic",
    conversation: session.conversation as ModelMessage[],
    searchResultCounter: session.searchResultCounter,
    searchResultsByLocalId: session.searchResultsByLocalId as Record<string, SearchResultFood>,
    pendingApprovals: session.pendingApprovals as Record<string, ResolvedApprovalSuggestion[]>,
  };
}

export async function saveAiSession(session: AiSessionState): Promise<void> {
  await db
    .update(aiSessions)
    .set({
      conversation: session.conversation,
      searchResultCounter: session.searchResultCounter,
      searchResultsByLocalId: session.searchResultsByLocalId,
      pendingApprovals: session.pendingApprovals,
      updatedAt: new Date(),
    })
    .where(and(eq(aiSessions.id, session.id), eq(aiSessions.userId, session.userId)));
}
