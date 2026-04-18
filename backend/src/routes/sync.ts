import { Hono } from "hono";
import { handleSyncBootstrapRequest, handleSyncPushRequest } from "../services/sync";

export const syncRoutes = new Hono();

syncRoutes.get("/bootstrap", (c) => handleSyncBootstrapRequest(c.req.raw));
syncRoutes.post("/push", (c) => handleSyncPushRequest(c.req.raw));
