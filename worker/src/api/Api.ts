import * as HttpApi from "effect/http-api/HttpApi";
import { AiGroup } from "../ai/Api.ts";
import { HealthGroup } from "../health/Api.ts";
import { InvalidRequest } from "./InvalidRequest.ts";
import { UnexpectedErrors } from "./UnexpectedErrors.ts";
import { MfpGroup } from "../mfp/Api.ts";
import { SearchGroup } from "../search/Api.ts";
import { SocialGroup } from "../social/Api.ts";
import { SyncGroup } from "../sync/Api.ts";

// The JSON API, wire-compatible with backend/. Non-JSON routes (Better Auth,
// the AI turn SSE stream, static web assets) are raw routes in Api.worker.ts.
export class Api extends HttpApi.make("caloric")
  .add(HealthGroup)
  .add(SyncGroup)
  .add(SocialGroup)
  .add(SearchGroup)
  .add(MfpGroup)
  .add(AiGroup)
  .middleware(InvalidRequest)
  .middleware(UnexpectedErrors) {}
