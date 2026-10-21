import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

export class EmailError extends Schema.TaggedError<EmailError>()("EmailError", {
  cause: Schema.Defect(),
}) {}

interface Message {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

// Transactional email through Resend. Without RESEND_API_KEY (dev stages),
// messages are logged instead so login codes stay recoverable.
export class Email extends Context.Service<
  Email,
  { readonly send: (message: Message) => Effect.Effect<void, EmailError> }
>()("caloric/email/Email") {
  static readonly layer = Layer.effect(
    Email,
    Effect.gen(function* () {
      const apiKey = yield* Config.Redacted("RESEND_API_KEY").pipe(Config.option);
      const from = yield* Config.String("AUTH_EMAIL_FROM").pipe(
        Config.withDefault("Caloric <login@caloric.mati.lol>"),
      );
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);

      const send = Effect.fn("Email.send")(function* (message: Message) {
        if (Option.isNone(apiKey)) {
          yield* Effect.logInfo("email.logged", { to: message.to, subject: message.subject, text: message.text });
          return;
        }
        yield* HttpClientRequest.post("https://api.resend.com/emails").pipe(
          HttpClientRequest.bearerToken(Redacted.value(apiKey.value)),
          HttpClientRequest.bodyJson({ from, ...message }),
          Effect.flatMap(client.execute),
          Effect.mapError((cause) => new EmailError({ cause })),
        );
      });

      return Email.of({ send });
    }),
  );
}

export const loginCodeEmail = (otp: string) => ({
  subject: "Your Caloric login code",
  text: `Your Caloric login code is ${otp}. It expires in 5 minutes.`,
  html: `<p>Your Caloric login code is <strong style="font-size:20px;letter-spacing:2px">${otp}</strong>.</p><p>It expires in 5 minutes. If you didn't request this, you can ignore this email.</p>`,
});
