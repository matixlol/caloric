import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { ReasoningEffort } from "../config";
import type { AssistantModel } from "./ai-agent";

export type ModelProviderKeys = {
  openRouterApiKey?: string;
  fetch?: typeof fetch;
};

// Builds the assistant model from an OpenRouter model ID, e.g. "meta/muse-wonder".
// An upstream can be pinned with "@<provider>", e.g. "thinkingmachines/inkling@together".
export function createAssistantModel(modelId: string, reasoningEffort: ReasoningEffort, keys: ModelProviderKeys): AssistantModel {
  const openrouter = createOpenRouter({ apiKey: keys.openRouterApiKey, fetch: keys.fetch, appName: "Caloric" });
  const [routerModel, upstream] = modelId.split("@") as [string, string | undefined];
  return {
    id: modelId,
    model: openrouter.chat(routerModel),
    providerOptions: {
      openrouter: {
        reasoning: { effort: reasoningEffort },
        // Reports the billed cost per call (providerMetadata.openrouter.usage.cost).
        usage: { include: true },
        ...(upstream ? { provider: { order: [upstream], allow_fallbacks: false } } : {}),
      },
    },
    telemetry: { provider: "openrouter", model: routerModel, reasoningEffort, ...(upstream ? { upstream } : {}) },
  };
}
