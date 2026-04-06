import * as Sentry from "@sentry/bun";

type PrimitiveSpanAttributeValue = string | number | boolean;
type SpanAttributeValue = PrimitiveSpanAttributeValue | string[] | number[] | boolean[];

type SpanAttributesInput = Record<string, unknown>;

type SpanOptions = {
  kind?: SpanKind;
  attributes?: SpanAttributesInput;
};

const SENTRY_DSN = "https://4d312c3af94cd2789193ccb90c4fd2e7@o4510397347987456.ingest.us.sentry.io/4511169851686912";
export const SENTRY_ENABLE_LOGS = true;
export const SENTRY_TRACES_SAMPLE_RATE = 1;
export const SENTRY_SERVICE_NAME = "caloric-backend";

export const SpanKind = {
  INTERNAL: 0,
  SERVER: 1,
  CLIENT: 2,
} as const;

export type SpanKind = (typeof SpanKind)[keyof typeof SpanKind];

export const SpanStatusCode = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const;

export type SpanStatusCode = (typeof SpanStatusCode)[keyof typeof SpanStatusCode];

export type Span = Sentry.Span;

function summarizeUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeAttributeValue(value: unknown): SpanAttributeValue | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [];
    }

    if (value.every((item) => typeof item === "string")) {
      return value;
    }

    if (value.every((item) => typeof item === "number")) {
      return value;
    }

    if (value.every((item) => typeof item === "boolean")) {
      return value;
    }

    return value.map((item) => summarizeUnknown(item));
  }

  return summarizeUnknown(value);
}

function normalizeAttributes(attributes: SpanAttributesInput | undefined): Record<string, SpanAttributeValue> {
  if (!attributes) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(attributes)
      .map(([key, value]) => [key, normalizeAttributeValue(value)] as const)
      .filter(([, value]) => value !== undefined),
  ) as Record<string, SpanAttributeValue>;
}

function toSentryOp(kind: SpanKind | undefined, name: string): string | undefined {
  if (kind === SpanKind.SERVER) {
    return "http.server";
  }

  if (kind === SpanKind.CLIENT) {
    if (name.includes("openrouter") || name.includes("groq")) {
      return "ai.client";
    }

    return "http.client";
  }

  if (name.startsWith("ai.")) {
    return "ai";
  }

  if (name.startsWith("food_search.")) {
    return "food.search";
  }

  return "function";
}

Sentry.init({
  dsn: SENTRY_DSN,
  enabled: true,
  enableLogs: SENTRY_ENABLE_LOGS,
  tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE,
  initialScope: {
    tags: {
      service: SENTRY_SERVICE_NAME,
    },
  },
});

export function getActiveTraceContext(): { traceId: string; spanId: string } | null {
  const spanContext = Sentry.getActiveSpan()?.spanContext();
  if (!spanContext) {
    return null;
  }

  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
  };
}

export function setActiveSpanAttributes(attributes: SpanAttributesInput): void {
  const span = Sentry.getActiveSpan();
  if (!span) {
    return;
  }

  span.setAttributes(normalizeAttributes(attributes));
}

export function recordSpanError(span: Span, error: unknown): void {
  const message = error instanceof Error ? error.message : summarizeUnknown(error);

  span.recordException(error);
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message,
  });

  Sentry.captureException(error);
}

export function captureException(error: unknown): void {
  Sentry.captureException(error);
}

export async function withSpan<T>(name: string, options: SpanOptions, fn: (span: Span) => Promise<T>): Promise<T> {
  return Sentry.startSpan(
    {
      name,
      op: toSentryOp(options.kind, name),
      forceTransaction: options.kind === SpanKind.SERVER,
      attributes: {
        ...normalizeAttributes(options.attributes),
        "service.name": SENTRY_SERVICE_NAME,
      },
    },
    async (span) => {
      try {
        return await fn(span);
      } catch (error) {
        recordSpanError(span, error);
        throw error;
      }
    },
  );
}
