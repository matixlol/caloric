import { describe, expect, test } from "bun:test";
import { createAssistantModel } from "./ai-models";

describe("createAssistantModel", () => {
  test("builds a Google model with a thinking level", () => {
    const assistant = createAssistantModel("google:gemini-3.8-flash", "low", { googleAiStudioApiKey: "test" });
    expect(assistant.id).toBe("google:gemini-3.8-flash");
    expect(assistant.telemetry).toEqual({ provider: "google-ai-studio", model: "gemini-3.8-flash", thinkingLevel: "low" });
    expect(assistant.providerOptions).toEqual({ google: { thinkingConfig: { thinkingLevel: "low" } } });
  });

  test("builds an OpenRouter model with reasoning effort", () => {
    const assistant = createAssistantModel("openrouter:qwen/qwen3.8-omni-flash", "medium", { openRouterApiKey: "test" });
    expect(assistant.telemetry?.model).toBe("qwen/qwen3.8-omni-flash");
    expect(assistant.providerOptions).toEqual({ openrouter: { reasoning: { effort: "medium" }, usage: { include: true } } });
  });

  test("pins an OpenRouter upstream provider", () => {
    const assistant = createAssistantModel("openrouter:thinkingmachines/inkling@together", "low", { openRouterApiKey: "test" });
    expect(assistant.telemetry).toMatchObject({ model: "thinkingmachines/inkling", upstream: "together" });
    expect(assistant.providerOptions).toEqual({
      openrouter: { reasoning: { effort: "low" }, usage: { include: true }, provider: { order: ["together"], allow_fallbacks: false } },
    });
  });

  test("treats a bare model name as Google and rejects unknown providers", () => {
    expect(createAssistantModel("gemini-3.6-flash", "low", {}).telemetry?.provider).toBe("google-ai-studio");
    expect(() => createAssistantModel("acme:model", "low", {})).toThrow('Unsupported assistant model provider "acme"');
  });
});
