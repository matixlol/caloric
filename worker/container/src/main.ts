import { transcodeAudioToWav } from "./audio.ts";
import { loginToMfp, readLoginConfig } from "./mfp/login.ts";
import { makeServer } from "./server.ts";

const port = Number(process.env.PORT ?? 8080);

const server = makeServer({
  // Read per login so a missing secret fails the request, not the boot.
  login: (signal) => loginToMfp(readLoginConfig(process.env), signal),
  toWav: (audio, signal) => transcodeAudioToWav(audio, { signal }),
});

server.requestTimeout = 0;
server.listen(port, "0.0.0.0", () => console.log(`caloric container listening on :${port}`));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close();
    server.closeAllConnections();
    process.exit(0);
  });
}
