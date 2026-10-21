import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import { AudioTranscodeError } from "../audio/AudioTranscoder.ts";
import { MfpLoginError, MfpLoginResult } from "../mfp/MfpLogin.ts";
import { CONTAINER_PORT, MfpContainer } from "./MfpContainer.ts";

// Every caller uses this one object, so there is one container and one
// in-flight browser login at a time.
export const MFP_BROWSER_INSTANCE = "mfp";

const LOGIN_TIMEOUT = Duration.minutes(5);
const AUDIO_TIMEOUT = Duration.seconds(90);
// The container stops (scales to zero) after this long without calls.
const IDLE_TIMEOUT = Duration.minutes(10);

const ContainerErrorBody = Schema.Struct({ error: Schema.String });

const describe = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string"
    ? cause.message
    : String(cause);

export class MfpBrowser extends Cloudflare.DurableObject<
  MfpBrowser,
  {
    readonly login: () => Effect.Effect<MfpLoginResult, MfpLoginError>;
    readonly toWav: (audio: Uint8Array, mediaType: string) => Effect.Effect<Uint8Array, AudioTranscodeError>;
  }
>()("MfpBrowser", { errors: [MfpLoginError, AudioTranscodeError] }) {}

export const MfpBrowserLive = MfpBrowser.make(
  Effect.gen(function* () {
    const container = yield* MfpContainer;

    return Effect.gen(function* () {
      const runtime = yield* RuntimeContext;
      const port = yield* container.getTcpPort(CONTAINER_PORT);

      const send = Effect.fnUntraced(function* (request: HttpClientRequest.HttpClientRequest) {
        yield* container.start({ enableInternet: true });
        yield* container.setInactivityTimeout(Duration.toMillis(IDLE_TIMEOUT));
        return yield* port.fetch(request);
      });

      const errorMessage = (response: HttpClientResponse.HttpClientResponse) =>
        HttpIncomingMessage.schemaBodyJson(ContainerErrorBody)(response).pipe(
          Effect.map((body) => body.error),
          Effect.orElseSucceed(() => `container responded ${response.status}`),
        );

      const login = Effect.fn("MfpBrowser.login")(
        function* () {
          const response = yield* send(HttpClientRequest.post(`http://container/mfp/login`));
          if (response.status !== 200) {
            return yield* new MfpLoginError({ message: yield* errorMessage(response) });
          }
          return yield* HttpIncomingMessage.schemaBodyJson(MfpLoginResult)(response);
        },
        Effect.timeoutOrElse({
          duration: LOGIN_TIMEOUT,
          orElse: () => Effect.fail(new MfpLoginError({ message: "MyFitnessPal login timed out." })),
        }),
        Effect.catchIf(
          (error) => !(error instanceof MfpLoginError),
          (error) => Effect.fail(new MfpLoginError({ message: `MyFitnessPal login failed: ${describe(error)}` })),
        ),
        Effect.provideService(RuntimeContext, runtime),
      );

      const toWav = Effect.fn("MfpBrowser.toWav")(
        function* (audio: Uint8Array, mediaType: string) {
          const response = yield* send(
            HttpClientRequest.post(`http://container/audio/wav`).pipe(HttpClientRequest.bodyUint8Array(audio, mediaType)),
          );
          if (response.status !== 200) {
            return yield* new AudioTranscodeError({ message: yield* errorMessage(response) });
          }
          return new Uint8Array(yield* response.arrayBuffer);
        },
        Effect.timeoutOrElse({
          duration: AUDIO_TIMEOUT,
          orElse: () => Effect.fail(new AudioTranscodeError({ message: "Voice note transcoding timed out." })),
        }),
        Effect.catchIf(
          (error) => !(error instanceof AudioTranscodeError),
          (error) => Effect.fail(new AudioTranscodeError({ message: `Voice note transcoding failed: ${describe(error)}` })),
        ),
        Effect.provideService(RuntimeContext, runtime),
      );

      return { login, toWav };
    });
  }),
);
