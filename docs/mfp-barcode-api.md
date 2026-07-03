# MyFitnessPal barcode API

MyFitnessPal's Android app performs barcode lookups through its legacy binary sync API. This is an undocumented private API, so the wire format or guest credential may change without notice.

## Request

- `POST https://sync.myfitnesspal.com/iphone_api/synchronize?lang=en_US`
- Multipart field: `syncdata` (`syncdata.dat`, `application/octet-stream`)
- Headers: `Authorization: Bearer <guest token>`, `mfp-client-id: mfp-mobile-android-google`, and a UUID `device_id`
- Body: big-endian binary packets with magic `0x04D3`. Send an information packet (type `100`, API version `28`) followed by a barcode-search packet (type `109`) containing an EAN-8 or EAN-13 string.

The first response packet (type `102`) contains the result code and packet count. Food packets use the legacy type `31` shape and contain identity, description, brand, barcode, 17 nutrient floats, and serving portions. Result `0x100` means success and `0x101` means no matches.

## Caloric integration

`GET /search/barcode/:barcode` validates the EAN, calls MFP, normalizes the food into Caloric's regular search-food shape, and stores both the raw binary response and parsed JSON in `mfp_barcode_responses`. Successful and no-match results use `SEARCH_CACHE_TTL_DAYS` (30 days by default).

Set `MFP_GUEST_ACCESS_TOKEN` on the backend. The value is distributed inside the MFP Android app but is intentionally kept out of this repository and never sent to Caloric clients.
