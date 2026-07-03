import { and, desc, eq, gte, inArray, isNotNull, lt } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db";
import { mfpBarcodeResponses } from "../db/schema";
import { lookupMfpBarcode, type MfpBarcodePayload } from "../providers/myfitnesspal/barcode-client";

const SUCCESS = 0x100;
const NO_MATCHES = 0x101;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mapPayload(barcode: string, payload: MfpBarcodePayload, cached: boolean) {
  return {
    barcode,
    provider: "mfp",
    cached,
    foods: payload.foods.map((food) => ({
      id: `mfp:barcode:${food.id}:${food.uid}`,
      canonicalKey: `mfp:barcode:${food.id}:${food.uid}`,
      source: "mfp",
      sourceLabel: "MFP",
      name: food.name,
      brand: food.brand,
      serving: food.serving,
      nutrition: food.nutrition,
    })),
  };
}

export async function handleBarcodeRequest(request: Request, rawBarcode: string) {
  if (request.method !== "GET") {
    return json({ error: "Method not allowed." }, 405);
  }

  const barcode = rawBarcode.trim();
  if (!/^\d{8}$|^\d{13}$/.test(barcode)) {
    return json({ error: "Barcode must be an EAN-8 or EAN-13 value." }, 400);
  }

  const cutoff = new Date(Date.now() - config.searchCacheTtlDays * 24 * 60 * 60 * 1000);
  const [cached] = await db
    .select({
      resultCode: mfpBarcodeResponses.resultCode,
      responseJson: mfpBarcodeResponses.responseJson,
    })
    .from(mfpBarcodeResponses)
    .where(
      and(
        eq(mfpBarcodeResponses.barcode, barcode),
        gte(mfpBarcodeResponses.mfpStatus, 200),
        lt(mfpBarcodeResponses.mfpStatus, 300),
        inArray(mfpBarcodeResponses.resultCode, [SUCCESS, NO_MATCHES]),
        isNotNull(mfpBarcodeResponses.responseJson),
        gte(mfpBarcodeResponses.createdAt, cutoff),
      ),
    )
    .orderBy(desc(mfpBarcodeResponses.createdAt), desc(mfpBarcodeResponses.id))
    .limit(1);

  if (cached?.responseJson) {
    const payload = cached.responseJson as MfpBarcodePayload;
    if (cached.resultCode === NO_MATCHES || payload.foods.length === 0) {
      return json({ barcode, provider: "mfp", cached: true, foods: [] }, 404);
    }
    return json(mapPayload(barcode, payload, true));
  }

  try {
    const response = await lookupMfpBarcode(barcode);
    await db.insert(mfpBarcodeResponses).values({
      barcode,
      mfpUrl: response.url,
      mfpStatus: response.status,
      resultCode: response.data?.resultCode,
      responseBody: response.body,
      responseJson: response.data,
    });

    if (!response.data) {
      return json({ error: "MFP barcode lookup failed." }, 502);
    }
    if (response.data.resultCode === NO_MATCHES || response.data.foods.length === 0) {
      return json({ barcode, provider: "mfp", cached: false, foods: [] }, 404);
    }
    if (response.data.resultCode !== SUCCESS) {
      return json({ error: "MFP rejected the barcode." }, 400);
    }
    return json(mapPayload(barcode, response.data, false));
  } catch (error) {
    console.error("mfp.barcode.failed", error);
    const unavailable = error instanceof Error && error.message.includes("not configured");
    return json({ error: unavailable ? "Barcode lookup is not configured." : "Barcode lookup failed." }, unavailable ? 503 : 502);
  }
}
