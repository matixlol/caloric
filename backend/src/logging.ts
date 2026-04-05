import * as Sentry from "@sentry/bun";
import { getActiveTraceContext } from "./tracing";

type LogValue = string | number | boolean | null | LogValue[] | { [key: string]: LogValue };

type LogFields = Record<string, LogValue | undefined>;

function compactFields(fields: LogFields): Record<string, LogValue> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Record<string, LogValue>;
}

export function redactSecret(value: string | undefined | null): string | null {
  if (!value) {
    return null;
  }

  if (value.length <= 8) {
    return `${value.slice(0, 2)}...${value.slice(-2)}`;
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function summarizeText(value: string | undefined | null, maxLength = 240): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function getTraceFields(): Record<string, string> {
  const traceContext = getActiveTraceContext();
  if (!traceContext) {
    return {};
  }

  return traceContext;
}

export function logInfo(event: string, fields: LogFields = {}): void {
  const payload = {
    level: "info",
    event,
    ...getTraceFields(),
    ...compactFields(fields),
  };

  console.log(JSON.stringify(payload));
  Sentry.logger.info(event, payload);
}

export function logError(event: string, error: unknown, fields: LogFields = {}): void {
  const normalizedError = error instanceof Error
    ? {
        name: error.name,
        message: error.message,
        stack: summarizeText(error.stack, 1000),
      }
    : {
        message: String(error),
      };

  const payload = {
    level: "error",
    event,
    ...getTraceFields(),
    ...compactFields(fields),
    error: normalizedError,
  };

  console.error(JSON.stringify(payload));
  Sentry.logger.error(event, payload);
}
