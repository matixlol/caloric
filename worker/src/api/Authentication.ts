import * as Context from "effect/Context";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import { ServiceUnavailable, Unauthorized } from "./Errors.ts";

export interface User {
  readonly id: string;
}

export class CurrentUser extends Context.Service<CurrentUser, User>()("caloric/api/CurrentUser") {}

// Resolves the Better Auth session cookie into the signed-in user. Endpoints
// that add this middleware fail with 401 when there is no valid session, and
// with 503 when the session store can't be reached.
export class Authentication extends HttpApiMiddleware.Service<Authentication, { provides: CurrentUser }>()(
  "caloric/api/Authentication",
  { error: [Unauthorized, ServiceUnavailable] },
) {}
