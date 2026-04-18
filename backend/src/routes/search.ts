import { Hono } from "hono";
import { handleAnmatLiveSearchRequest, handleSearchRequest } from "../services/search";

export const searchRoutes = new Hono();

searchRoutes.get("/", (c) => handleSearchRequest(c.req.raw));
searchRoutes.post("/anmat-live", (c) => handleAnmatLiveSearchRequest(c.req.raw));
