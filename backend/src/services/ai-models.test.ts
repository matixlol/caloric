import { describe, expect, test } from "bun:test";
import { createAssistantModel } from "./ai-models";

describe("createAssistantModel", () => {
  test("builds an OpenRouter model with reasoning effort and cost reporting", () => {
    const assistant = createAssistantModel("meta/muse-wonder", "minimal", { openRouterApiKey: "test" });
    expect(assistant.id).toBe("meta/muse-wonder");
    expect(assistant.telemetry).toEqual({ provider: "openrouter", model: "meta/muse-wonder", reasoningEffort: "minimal" });
    expect(assistant.providerOptions).toEqual({ openrouter: { reasoning: { effort: "minimal" }, usage: { include: true } } });
  });

  test("pins an OpenRouter upstream provider", () => {
    const assistant = createAssistantModel("thinkingmachines/inkling@together", "low", { openRouterApiKey: "test" });
    expect(assistant.telemetry).toMatchObject({ model: "thinkingmachines/inkling", upstream: "together" });
    expect(assistant.providerOptions).toEqual({
      openrouter: { reasoning: { effort: "low" }, usage: { include: true }, provider: { order: ["together"], allow_fallbacks: false } },
    });
  });
});
