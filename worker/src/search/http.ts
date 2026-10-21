import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { Api } from "../api/Api.ts";

// TODO(port): handlers for /search.
export const SearchHandlers = HttpApiBuilder.group(Api, "search", (handlers) => handlers);
