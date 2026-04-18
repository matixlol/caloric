import { Hono } from "hono";
import { handleAiSessionRequest, handleAiTurnRequest } from "../services/ai";

export const aiRoutes = new Hono();

aiRoutes.post("/session", (c) => handleAiSessionRequest(c.req.raw));
aiRoutes.post("/turn", (c) => handleAiTurnRequest(c.req.raw));
