import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { Api } from "../api/Api.ts";

// TODO(port): handlers for /ai.
export const AiHandlers = HttpApiBuilder.group(Api, "ai", (handlers) => handlers);
