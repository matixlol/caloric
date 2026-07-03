import { describe, expect, it } from "bun:test";
import { buildBarcodeRequest, parseBarcodeResponse } from "./barcode-client";

function fromHex(value: string) {
  return Uint8Array.from(value.trim().split(/\s+/).map((byte) => Number.parseInt(byte, 16)));
}

const NUTELLA_RESPONSE = fromHex(`
  04 d3 00 00 00 1a 00 01 00 66 00 00 00 00 00 00 00 01 01 00 00 00 00 00 00 01
  04 d3 00 00 01 01 00 01 00 1f a1 cf af 38 00 0e 35 34 30 33 30 32 30 32 39 33 32 37 38 39
  0c a3 c2 91 0e c2 80 2c 00 0f 32 36 35 31 35 31 38 38 31 39 39 38 31 38 39 00 0f 4e 75
  74 65 6c 6c 61 20 46 65 72 72 65 72 6f 00 07 4e 75 74 65 6c 6c 61 00 00 00 00 00 01
  42 a0 00 00 40 a0 00 00 40 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 3f 80 00 00
  40 c9 99 9a 00 00 00 00 41 10 00 00 00 00 00 00 41 00 00 00 3f 80 00 00 00 00 00 00
  00 00 00 00 00 00 00 00 00 00 00 00 41 70 00 00 00 00 00 05 41 70 00 00 41 70 00 00
  00 01 67 00 00 3f 80 00 00 3f 80 00 00 00 01 67 00 00 3f 80 00 00 44 61 00 00 00 16
  63 6f 6e 74 61 69 6e 65 72 20 28 39 30 30 20 67 73 20 65 61 2e 29 00 00 3f 00 00 00
  41 62 cb 92 00 05 6f 75 6e 63 65 00 00 3f 80 00 00 41 e2 cb fb 00 05 6f 75 6e 63 65 00 00
`);

describe("MFP barcode binary protocol", () => {
  it("builds information and barcode-search packets", () => {
    const request = buildBarcodeRequest("3017624010701", "00112233-4455-6677-8899-aabbccddeeff");
    expect(request[0]).toBe(0x04);
    expect(request[1]).toBe(0xd3);
    expect(new TextDecoder().decode(request)).toContain("3017624010701");
  });

  it("decodes a real MFP food response", () => {
    const result = parseBarcodeResponse(NUTELLA_RESPONSE);
    expect(result.resultCode).toBe(0x100);
    expect(result.foods).toHaveLength(1);
    expect(result.foods[0]).toMatchObject({
      name: "Nutella Ferrero",
      brand: "Nutella",
      serving: "15 g",
      nutrition: { calories: 80, fat: 5, carbs: 9, sugars: 8, protein: 1 },
    });
  });
});
