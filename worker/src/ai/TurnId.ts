import * as Option from "effect/Option";
import { aiTurnId } from "../ids.ts";

// Turns run inside their session's Durable Object, but the resume endpoint only
// receives a turn id. Turn ids therefore embed the session's TypeID suffix:
// "ai_turn_<turn suffix>_<session suffix>". Clients treat the id as opaque.

const suffix = (typeId: string, prefix: string): Option.Option<string> => {
  const match = new RegExp(`^${prefix}_([0-9a-z]{26})$`).exec(typeId);
  return match ? Option.some(match[1]!) : Option.none();
};

// None for ids this Worker never issued (sessions are always TypeIDs).
export const makeTurnId = (sessionId: string): Option.Option<string> =>
  Option.map(suffix(sessionId, "ai_session"), (session) => `${aiTurnId()}_${session}`);

export const sessionIdOfTurn = (turnId: string): Option.Option<string> => {
  const match = /^ai_turn_[0-9a-z]{26}_([0-9a-z]{26})$/.exec(turnId);
  return match ? Option.some(`ai_session_${match[1]}`) : Option.none();
};
