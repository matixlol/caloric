import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { ProviderConfig } from "../ProviderConfig.ts";
import { ANDROID_VERSION_CODE, buildBarcodeRequest, type MfpBarcodePayload, parseBarcodeResponse } from "./barcodeProtocol.ts";

export const MFP_SYNC_URL = "https://sync.myfitnesspal.com/iphone_api/synchronize?lang=en_US";

export class MfpBarcodeNotConfigured extends Schema.TaggedError<MfpBarcodeNotConfigured>()(
  "MfpBarcodeNotConfigured",
  { message: Schema.String },
) {}

export class MfpBarcodeError extends Schema.TaggedError<MfpBarcodeError>()("MfpBarcodeError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface MfpBarcodeResponse {
  readonly status: number;
  readonly url: string;
  readonly body: Uint8Array;
  // Null when MFP answered with a non-2xx status.
  readonly data: MfpBarcodePayload | null;
}

const make = Effect.gen(function* () {
  const config = yield* ProviderConfig;
  const client = yield* HttpClient.HttpClient;

  // Looks a barcode up the way the Android app does, with a guest token.
  const lookup = Effect.fn("MfpBarcodeClient.lookup")(function* (barcode: string) {
    if (Option.isNone(config.mfpGuestAccessToken) || !Redacted.value(config.mfpGuestAccessToken.value).trim()) {
      return yield* new MfpBarcodeNotConfigured({ message: "MFP_GUEST_ACCESS_TOKEN is not configured" });
    }
    const token = Redacted.value(config.mfpGuestAccessToken.value).trim();
    const deviceId = crypto.randomUUID();
    const form = new FormData();
    form.append(
      "syncdata",
      new Blob([buildBarcodeRequest(barcode, deviceId)], { type: "application/octet-stream" }),
      "syncdata.dat",
    );

    const response = yield* HttpClientRequest.post(MFP_SYNC_URL).pipe(
      HttpClientRequest.setHeaders({
        Authorization: `Bearer ${token}`,
        "mfp-client-id": "mfp-mobile-android-google",
        device_id: deviceId,
        "User-Agent": `MyFitnessPal/${ANDROID_VERSION_CODE} Android`,
      }),
      HttpClientRequest.bodyFormData(form),
      client.execute,
      Effect.flatMap((response) =>
        Effect.map(response.arrayBuffer, (buffer) => ({
          status: response.status,
          url: response.url || MFP_SYNC_URL,
          body: new Uint8Array(buffer),
        })),
      ),
      Effect.timeout(config.requestTimeout),
      // Don't leak our trace headers to a third party.
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.mapError((cause) => new MfpBarcodeError({ message: "MFP barcode request failed", cause })),
    );

    const ok = response.status >= 200 && response.status < 300;
    const data = ok
      ? yield* Effect.try({
          try: () => parseBarcodeResponse(response.body),
          catch: (cause) => new MfpBarcodeError({ message: "MFP returned an unreadable barcode response", cause }),
        })
      : null;
    return { ...response, data } satisfies MfpBarcodeResponse;
  });

  return { lookup };
});

export class MfpBarcodeClient extends Context.Service<MfpBarcodeClient, Effect.Success<typeof make>>()(
  "caloric/providers/MfpBarcodeClient",
) {
  static readonly layer = Layer.effect(MfpBarcodeClient, make);
}
