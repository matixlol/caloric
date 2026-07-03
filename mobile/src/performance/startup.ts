import * as Sentry from "@sentry/react-native";

type StartupAttribute = string | number | boolean;
type StartupAttributes = Record<string, StartupAttribute>;

type ReactNativeStartupTiming = {
  startTime?: number | null;
  initializeRuntimeStart?: number | null;
  executeJavaScriptBundleEntryPointStart?: number | null;
  endTime?: number | null;
};

const moduleLoadedAt = performance.now();
let startupBreakdownSpan: ReturnType<typeof Sentry.startInactiveSpan> | null = null;
let startupBreakdownTimeout: ReturnType<typeof setTimeout> | null = null;

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getReactNativeStartupTiming(): ReactNativeStartupTiming | undefined {
  try {
    return (
      performance as typeof performance & {
        rnStartupTiming?: ReactNativeStartupTiming;
      }
    ).rnStartupTiming;
  } catch {
    return undefined;
  }
}

function getStartupOrigin(): number {
  return finiteNumber(getReactNativeStartupTiming()?.startTime) ?? moduleLoadedAt;
}

export function getReactNativeStartupAttributes(): StartupAttributes {
  const timing = getReactNativeStartupTiming();
  if (!timing) {
    return {};
  }

  const startTime = finiteNumber(timing.startTime);
  const runtimeStart = finiteNumber(timing.initializeRuntimeStart);
  const bundleStart = finiteNumber(timing.executeJavaScriptBundleEntryPointStart);
  const endTime = finiteNumber(timing.endTime);
  const attributes: StartupAttributes = {};

  if (startTime !== undefined) attributes["startup.rn_start_ms"] = roundMs(startTime);
  if (runtimeStart !== undefined) attributes["startup.runtime_start_ms"] = roundMs(runtimeStart);
  if (bundleStart !== undefined) attributes["startup.bundle_start_ms"] = roundMs(bundleStart);
  if (endTime !== undefined) attributes["startup.rn_end_ms"] = roundMs(endTime);
  if (startTime !== undefined && endTime !== undefined) {
    attributes["startup.rn_total_ms"] = roundMs(endTime - startTime);
  }
  if (startTime !== undefined && runtimeStart !== undefined) {
    attributes["startup.native_to_runtime_ms"] = roundMs(runtimeStart - startTime);
  }
  if (runtimeStart !== undefined && bundleStart !== undefined) {
    attributes["startup.runtime_to_bundle_ms"] = roundMs(bundleStart - runtimeStart);
  }
  if (bundleStart !== undefined && endTime !== undefined) {
    attributes["startup.bundle_to_rn_end_ms"] = roundMs(endTime - bundleStart);
  }

  return attributes;
}

export function logStartupMilestone(name: string, attributes: StartupAttributes = {}): void {
  const payload: StartupAttributes = {
    "startup.milestone": name,
    "startup.elapsed_ms": roundMs(performance.now() - getStartupOrigin()),
    ...attributes,
  };

  startupBreakdownSpan?.addEvent(name, payload);
  Sentry.logger.info(`mobile.startup.${name}`, payload);

  if (__DEV__) {
    console.info(`[startup] ${name}`, payload);
  }
}

export function startStartupBreakdownTrace(
  startTime?: number,
  attributes: StartupAttributes = {},
): void {
  if (startupBreakdownSpan) {
    return;
  }

  startupBreakdownSpan = Sentry.startInactiveSpan({
    name: "Mobile startup breakdown",
    op: "app.startup",
    forceTransaction: true,
    startTime,
    attributes: {
      ...getReactNativeStartupAttributes(),
      ...attributes,
    },
  });
  startupBreakdownTimeout = setTimeout(() => {
    startupBreakdownSpan?.setAttribute("startup.timed_out", true);
    startupBreakdownSpan?.end();
    startupBreakdownSpan = null;
    startupBreakdownTimeout = null;
  }, 30_000);
}

export function finishStartupBreakdownTrace(attributes: StartupAttributes = {}): void {
  if (!startupBreakdownSpan) {
    return;
  }

  startupBreakdownSpan.setAttributes({
    "startup.elapsed_ms": roundMs(performance.now() - getStartupOrigin()),
    ...attributes,
  });
  startupBreakdownSpan.end();
  startupBreakdownSpan = null;

  if (startupBreakdownTimeout) {
    clearTimeout(startupBreakdownTimeout);
    startupBreakdownTimeout = null;
  }
}

export async function traceStartupOperation<T>(
  {
    name,
    op,
    attributes = {},
  }: {
    name: string;
    op: string;
    attributes?: StartupAttributes;
  },
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();

  return Sentry.startSpan(
    {
      name: `mobile.startup.${name}`,
      op,
      parentSpan: startupBreakdownSpan ?? undefined,
      onlyIfParent: true,
      attributes: {
        "startup.operation": name,
        ...attributes,
      },
    },
    async (span) => {
      try {
        const result = await operation();
        const durationMs = roundMs(performance.now() - startedAt);
        const resultCount = Array.isArray(result) ? result.length : result == null ? 0 : 1;

        span.setAttributes({
          "startup.duration_ms": durationMs,
          "startup.result_count": resultCount,
        });
        logStartupMilestone(`${name}.completed`, {
          "startup.duration_ms": durationMs,
          "startup.result_count": resultCount,
          ...attributes,
        });

        return result;
      } catch (error) {
        const durationMs = roundMs(performance.now() - startedAt);
        span.setAttributes({
          "startup.duration_ms": durationMs,
          "startup.failed": true,
        });
        Sentry.logger.error(`mobile.startup.${name}.failed`, {
          "startup.operation": name,
          "startup.duration_ms": durationMs,
          "error.type": error instanceof Error ? error.name : typeof error,
          ...attributes,
        });
        throw error;
      }
    },
  );
}
