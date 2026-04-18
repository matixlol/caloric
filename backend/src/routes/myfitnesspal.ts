import { Hono } from "hono";
import { handleMfpSessionRefreshRequest } from "../services/search";

export const myFitnessPalRoutes = new Hono();

myFitnessPalRoutes.post("/session/refresh", () => handleMfpSessionRefreshRequest());
