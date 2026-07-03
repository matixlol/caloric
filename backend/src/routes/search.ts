import { Hono } from "hono";
import { handleAnmatLiveSearchRequest, handleSearchRequest } from "../services/search";
import { handleBarcodeRequest } from "../services/barcode";

export const searchRoutes = new Hono();

searchRoutes.get("/", (c) => handleSearchRequest(c.req.raw));
searchRoutes.get("/barcode/:barcode", (c) => handleBarcodeRequest(c.req.raw, c.req.param("barcode")));
searchRoutes.post("/anmat-live", (c) => handleAnmatLiveSearchRequest(c.req.raw));
