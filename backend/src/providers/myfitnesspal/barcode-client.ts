import { config } from "../../config";

export const MFP_SYNC_URL = "https://sync.myfitnesspal.com/iphone_api/synchronize?lang=en_US";
const PACKET_MAGIC = 0x04d3;
const PACKET_VERSION = 1;
const INFORMATION_PACKET = 100;
const BARCODE_SEARCH_PACKET = 109;
const FOOD_PACKET = 31;
const API_VERSION = 28;
const ANDROID_VERSION_CODE = 50_942;
const ANDROID_PLATFORM = 2;

export type MfpBarcodeFood = {
  id: string;
  uid: string;
  barcode: string;
  name: string;
  brand?: string;
  serving?: string;
  nutrition: {
    calories?: number;
    protein?: number;
    carbs?: number;
    fat?: number;
    fiber?: number;
    sugars?: number;
    sodiumMg?: number;
    potassiumMg?: number;
  };
};

export type MfpBarcodePayload = {
  resultCode: number;
  error: string;
  foods: MfpBarcodeFood[];
};

class Writer {
  private bytes: number[] = [];

  u16(value: number) {
    this.bytes.push((value >>> 8) & 0xff, value & 0xff);
  }

  u32(value: number) {
    this.bytes.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  }

  u64(value: bigint) {
    this.u32(Number((value >> 32n) & 0xffffffffn));
    this.u32(Number(value & 0xffffffffn));
  }

  raw(value: Uint8Array) {
    this.bytes.push(...value);
  }

  string(value: string) {
    const encoded = new TextEncoder().encode(value);
    this.u16(encoded.length);
    this.raw(encoded);
  }

  finish() {
    return Uint8Array.from(this.bytes);
  }
}

class Reader {
  offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get remaining() {
    return this.bytes.length - this.offset;
  }

  private take(length: number) {
    if (length < 0 || this.offset + length > this.bytes.length) {
      throw new Error("MFP returned a truncated binary response");
    }
    const result = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  u16() {
    const value = this.take(2);
    return (value[0] << 8) | value[1];
  }

  u32() {
    const value = this.take(4);
    return ((value[0] * 0x1000000) + (value[1] << 16) + (value[2] << 8) + value[3]) >>> 0;
  }

  u64() {
    return (BigInt(this.u32()) << 32n) | BigInt(this.u32());
  }

  float() {
    const value = this.take(4);
    return new DataView(value.buffer, value.byteOffset, 4).getFloat32(0, false);
  }

  bool() {
    return this.u16() !== 0;
  }

  string() {
    return new TextDecoder().decode(this.take(this.u16()));
  }
}

function packet(type: number, payload: Uint8Array) {
  const writer = new Writer();
  writer.u16(PACKET_MAGIC);
  writer.u32(payload.length + 10);
  writer.u16(PACKET_VERSION);
  writer.u16(type);
  writer.raw(payload);
  return writer.finish();
}

function uuidBytes(uuid: string) {
  const hex = uuid.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    throw new Error("Invalid device UUID");
  }
  return Uint8Array.from(hex.match(/../g)!.map((part) => Number.parseInt(part, 16)));
}

export function buildBarcodeRequest(barcode: string, deviceId = crypto.randomUUID()) {
  const info = new Writer();
  info.u16(API_VERSION);
  info.u32(ANDROID_VERSION_CODE);
  info.u64(1n);
  info.u16(0);
  info.u16(ANDROID_PLATFORM);
  info.u16(14);
  info.u16(0);
  info.raw(uuidBytes(deviceId));
  info.string(":");

  const search = new Writer();
  search.string(barcode);

  const infoPacket = packet(INFORMATION_PACKET, info.finish());
  const searchPacket = packet(BARCODE_SEARCH_PACKET, search.finish());
  const body = new Uint8Array(infoPacket.length + searchPacket.length);
  body.set(infoPacket);
  body.set(searchPacket, infoPacket.length);
  return body;
}

function cleanNumber(value: number): number | undefined {
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseFood(payload: Uint8Array): MfpBarcodeFood {
  const reader = new Reader(payload);
  // Food packet 31 uses the legacy v1 shape, which is narrower than the v15
  // FoodObject used elsewhere in the app.
  const masterId = reader.u32().toString();
  const uid = reader.string();
  reader.u64(); // owner master user id
  reader.string(); // original uid
  const name = reader.string();
  const brand = reader.string();
  const barcode = reader.string();
  reader.u32(); // flags

  const nutrients = Array.from({ length: 17 }, () => reader.float());
  reader.float(); // gram weight represented by the nutrient array
  reader.u16(); // food type
  const portionCount = reader.u16();
  let serving: string | undefined;
  for (let index = 0; index < portionCount; index += 1) {
    const amount = reader.float();
    reader.float(); // gram weight
    const description = reader.string();
    reader.bool();
    if (!serving && description) {
      serving = `${Number.isInteger(amount) ? amount : Number(amount.toFixed(2))} ${description}`;
    }
  }
  return {
    id: masterId,
    uid,
    barcode,
    name,
    brand: brand || undefined,
    serving,
    nutrition: {
      calories: cleanNumber(nutrients[0]),
      fat: cleanNumber(nutrients[1]),
      sodiumMg: cleanNumber(nutrients[7]),
      potassiumMg: cleanNumber(nutrients[8]),
      carbs: cleanNumber(nutrients[9]),
      fiber: cleanNumber(nutrients[10]),
      sugars: cleanNumber(nutrients[11]),
      protein: cleanNumber(nutrients[12]),
    },
  };
}

export function parseBarcodeResponse(bytes: Uint8Array): MfpBarcodePayload {
  const reader = new Reader(bytes);
  let resultCode = 0;
  let error = "";
  const foods: MfpBarcodeFood[] = [];

  while (reader.remaining > 0) {
    if (reader.u16() !== PACKET_MAGIC) {
      throw new Error("MFP returned an invalid packet header");
    }
    const length = reader.u32();
    reader.u16();
    const type = reader.u16();
    const payloadLength = length - 10;
    if (payloadLength < 0 || payloadLength > reader.remaining) {
      throw new Error("MFP returned an invalid packet length");
    }
    const payloadStart = reader.offset;
    const payload = bytes.subarray(payloadStart, payloadStart + payloadLength);
    reader.offset += payloadLength;

    if (type === 102) {
      const metadata = new Reader(payload);
      metadata.u64();
      resultCode = metadata.u16();
      error = metadata.string();
      metadata.u32();
    } else if (type === FOOD_PACKET) {
      foods.push(parseFood(payload));
    }
  }

  return { resultCode, error, foods };
}

export async function lookupMfpBarcode(barcode: string): Promise<{
  status: number;
  url: string;
  body: Uint8Array;
  data: MfpBarcodePayload | null;
}> {
  const token = config.mfpGuestAccessToken?.trim();
  if (!token) {
    throw new Error("MFP_GUEST_ACCESS_TOKEN is not configured");
  }

  const deviceId = crypto.randomUUID();
  const form = new FormData();
  form.append(
    "syncdata",
    new Blob([buildBarcodeRequest(barcode, deviceId)], { type: "application/octet-stream" }),
    "syncdata.dat",
  );
  const response = await fetch(MFP_SYNC_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "mfp-client-id": "mfp-mobile-android-google",
      device_id: deviceId,
      "User-Agent": "MyFitnessPal/50942 Android",
    },
    body: form,
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  const body = new Uint8Array(await response.arrayBuffer());
  return {
    status: response.status,
    url: response.url || MFP_SYNC_URL,
    body,
    data: response.ok ? parseBarcodeResponse(body) : null,
  };
}
