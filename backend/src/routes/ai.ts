import { Hono } from "hono";
import { handleAiSessionRequest, handleAiTurnRequest, handleAiTurnStreamRequest } from "../services/ai";

export const aiRoutes = new Hono();

aiRoutes.post("/session", (c) => handleAiSessionRequest(c.req.raw));
aiRoutes.post("/turn", (c) => handleAiTurnRequest(c.req.raw));
aiRoutes.get("/turn/:turnId/stream", (c) => handleAiTurnStreamRequest(c.req.raw, c.req.param("turnId")));
