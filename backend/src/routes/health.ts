import { Hono } from "hono";
import { handleHealthRequest } from "../services/health";

export const healthRoutes = new Hono();

healthRoutes.get("/health", () => handleHealthRequest());
