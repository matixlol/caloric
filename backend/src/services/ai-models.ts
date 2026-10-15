import { createGoogleGenerativeAI, type GoogleLanguageModelOptions } from "@ai-sdk/google";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { AssistantModel } from "./ai-agent";

export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

export type ModelProviderKeys = {
  googleAiStudioApiKey?: string;
  openRouterApiKey?: string;
  fetch?: typeof fetch;
};

// Builds an assistant model from a "<provider>:<model>" spec, e.g.
// "google:gemini-3.8-flash" or "openrouter:qwen/qwen3.8-omni-flash". OpenRouter
// specs may pin an upstream with "@<provider>", e.g. "openrouter:thinkingmachines/inkling@together".
export function createAssistantModel(spec: string, thinkingLevel: ThinkingLevel, keys: ModelProviderKeys): AssistantModel {
  const separator = spec.indexOf(":");
  const provider = separator > 0 ? spec.slice(0, separator) : "google";
  const modelId = separator > 0 ? spec.slice(separator + 1) : spec;

  if (provider === "google") {
    const google = createGoogleGenerativeAI({ apiKey: keys.googleAiStudioApiKey, fetch: keys.fetch });
    return {
      id: spec,
      model: google.chat(modelId),
      providerOptions: {
        google: {
          thinkingConfig: { thinkingLevel },
        } satisfies GoogleLanguageModelOptions,
      },
      telemetry: { provider: "google-ai-studio", model: modelId, thinkingLevel },
    };
  }

  if (provider === "openrouter") {
    const openrouter = createOpenRouter({ apiKey: keys.openRouterApiKey, fetch: keys.fetch, appName: "Caloric" });
    const [routerModel, upstream] = modelId.split("@") as [string, string | undefined];
    return {
      id: spec,
      model: openrouter.chat(routerModel),
      providerOptions: {
        openrouter: {
          reasoning: { effort: thinkingLevel },
          // Reports the billed cost per call (providerMetadata.openrouter.usage.cost).
          usage: { include: true },
          ...(upstream ? { provider: { order: [upstream], allow_fallbacks: false } } : {}),
        },
      },
      telemetry: { provider: "openrouter", model: routerModel, thinkingLevel, ...(upstream ? { upstream } : {}) },
    };
  }

  throw new Error(`Unsupported assistant model provider "${provider}" in "${spec}".`);
}
