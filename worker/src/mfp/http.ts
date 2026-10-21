import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { Api } from "../api/Api.ts";

// TODO(port): handlers for /mfp.
export const MfpHandlers = HttpApiBuilder.group(Api, "mfp", (handlers) => handlers);
