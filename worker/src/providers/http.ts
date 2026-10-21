import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

// An upstream response as backend/ cached it: parsed JSON when the body is
// JSON, otherwise the raw text.
export interface UpstreamResponse {
  readonly status: number;
  readonly url: string;
  readonly json: unknown | null;
  readonly text: string | null;
}

const parseJson = (text: string): unknown | null => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

export const readUpstreamResponse = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.map(response.text, (text): UpstreamResponse => {
    const json = parseJson(text);
    return { status: response.status, url: response.url, json, text: json ? null : text };
  });

// Third-party APIs get no b3/traceparent headers from us.
export const withoutTracePropagation = Effect.provideService(HttpClient.TracerPropagationEnabled, false);
