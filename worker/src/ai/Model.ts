import * as OpenRouterClient from "@effect/ai-openrouter/OpenRouterClient";
import * as OpenRouterLanguageModel from "@effect/ai-openrouter/OpenRouterLanguageModel";
import * as LanguageModel from "effect/ai/LanguageModel";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

export const reasoningEfforts = ["minimal", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof reasoningEfforts)[number];

type RequestConfig = Omit<typeof OpenRouterLanguageModel.Config.Service, "model">;

// Splits an OpenRouter model id into the routed model and request defaults.
// An upstream can be pinned with "@<provider>", e.g.
// "thinkingmachines/inkling@together" -> provider.order ["together"], no fallbacks.
export const openRouterModel = (
  modelId: string,
  reasoningEffort: ReasoningEffort,
): { readonly model: string; readonly config: RequestConfig } => {
  const [model = modelId, upstream] = modelId.split("@");
  return {
    model,
    config: {
      reasoning: { effort: reasoningEffort },
      ...(upstream ? { provider: { order: [upstream], allow_fallbacks: false } } : {}),
    },
  };
};

// The assistant's LanguageModel, configured from the Worker's environment at
// construction time. The API key is optional so stages without one still boot;
// turns then fail with OpenRouter's authentication error, as in backend/. OpenRouter reports billed cost in every response's
// `usage.cost` (finish part metadata), so no extra request flag is needed.
export const AssistantModelLive: Layer.Layer<
  LanguageModel.LanguageModel,
  Config.ConfigError,
  HttpClient.HttpClient
> = Layer.effect(
  LanguageModel.LanguageModel,
  Effect.gen(function* () {
    const apiKey = yield* Config.Redacted("OPENROUTER_API_KEY").pipe(Config.option);
    const modelId = yield* Config.String("AI_MODEL").pipe(Config.withDefault("meta/muse-wonder"));
    const effort = yield* Config.Literals(reasoningEfforts, "AI_REASONING_EFFORT").pipe(
      Config.withDefault<ReasoningEffort>("minimal"),
    );
    const client = yield* OpenRouterClient.make({ apiKey: Option.getOrUndefined(apiKey), siteTitle: "Caloric" });
    return yield* OpenRouterLanguageModel.make(openRouterModel(modelId, effort)).pipe(
      Effect.provideService(OpenRouterClient.OpenRouterClient, client),
    );
  }),
);
