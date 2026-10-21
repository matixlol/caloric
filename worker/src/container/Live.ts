import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AudioTranscodeError, AudioTranscoder } from "../audio/AudioTranscoder.ts";
import { MfpLogin, MfpLoginError } from "../mfp/MfpLogin.ts";
import { MFP_BROWSER_INSTANCE, MfpBrowser, MfpBrowserLive } from "./MfpBrowser.ts";

// Failures crossing the Durable Object RPC boundary can also be transport
// errors (RpcCallError) that the stub types don't declare.
const describe = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string"
    ? cause.message
    : String(cause);

export const MfpLoginLive = Layer.effect(
  MfpLogin,
  Effect.gen(function* () {
    const browsers = yield* MfpBrowser;
    return MfpLogin.of({
      login: (options) =>
        browsers.getByName(MFP_BROWSER_INSTANCE).login(options.newerThan).pipe(
          Effect.mapError((error: unknown) =>
            error instanceof MfpLoginError ? error : new MfpLoginError({ message: describe(error), cause: error }),
          ),
          Effect.withSpan("MfpLogin.login"),
        ),
    });
  }),
).pipe(Layer.provide(MfpBrowserLive));

export const AudioTranscoderLive = Layer.effect(
  AudioTranscoder,
  Effect.gen(function* () {
    const browsers = yield* MfpBrowser;
    return AudioTranscoder.of({
      toWav: Effect.fn("AudioTranscoder.toWav")(
        function* (audio: Uint8Array, mediaType: string) {
          return yield* browsers.getByName(MFP_BROWSER_INSTANCE).toWav(audio, mediaType);
        },
        Effect.mapError((error: unknown) =>
          error instanceof AudioTranscodeError ? error : new AudioTranscodeError({ message: describe(error), cause: error }),
        ),
      ),
    });
  }),
).pipe(Layer.provide(MfpBrowserLive));
