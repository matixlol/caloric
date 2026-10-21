import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { Api } from "../api/Api.ts";

// TODO(port): handlers for /social.
export const SocialHandlers = HttpApiBuilder.group(Api, "social", (handlers) => handlers);
