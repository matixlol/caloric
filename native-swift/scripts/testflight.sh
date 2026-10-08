#!/bin/bash
set -eo pipefail
cd "$(dirname "$0")/.."
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
caloric_apple_credentials="${CALORIC_APPLE_CREDENTIALS:-$HOME/.config/caloric/apple.json}"
if [[ -f "$caloric_apple_credentials" ]]; then
  caloric_credential_setting() {
    python3 - "$caloric_apple_credentials" "$1" <<'PY'
import json, sys
with open(sys.argv[1]) as file:
    value = json.load(file)[sys.argv[2]]
if not isinstance(value, str) or '\n' in value or '\r' in value:
    raise SystemExit('Invalid Apple credential configuration')
print(value)
PY
  }
  ASC_KEY_PATH="${ASC_KEY_PATH:-$(caloric_credential_setting keyPath)}"
  ASC_KEY_ID="${ASC_KEY_ID:-$(caloric_credential_setting keyID)}"
  ASC_ISSUER_ID="${ASC_ISSUER_ID:-$(caloric_credential_setting issuerID)}"
fi
if [[ ! -f Config/Local.xcconfig ]]; then
  python3 scripts/configure.py
fi
if [[ -z "${APPLE_TEAM_ID:-}" ]] && ! /usr/bin/grep -q '^DEVELOPMENT_TEAM = [A-Z0-9]' Config/Local.xcconfig; then
  echo 'Set APPLE_TEAM_ID and run scripts/configure.py, or set DEVELOPMENT_TEAM in Config/Local.xcconfig.' >&2
  exit 1
fi
mkdir -p build
node scripts/provision-release.mjs
caloric_export_options="$(python3 scripts/prepare-signing.py)"
args=()
build_args=()
if [[ -n "${BUILD_NUMBER:-}" ]]; then build_args+=("CURRENT_PROJECT_VERSION=$BUILD_NUMBER"); fi
if [[ -n "${ASC_KEY_PATH:-}" ]]; then
  : "${ASC_KEY_ID:?Set ASC_KEY_ID}" "${ASC_ISSUER_ID:?Set ASC_ISSUER_ID}"
  args+=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
fi
if [[ "${CALORIC_EXPORT_ONLY:-0}" != "1" ]]; then
  xcodebuild -project CaloricSwift.xcodeproj -scheme CaloricSwift -configuration Release \
    -destination 'generic/platform=iOS' -derivedDataPath build/ArchiveDerivedData \
    -archivePath build/CaloricSwift.xcarchive "${build_args[@]}" archive
fi
python3 scripts/verify-archive.py build/CaloricSwift.xcarchive
xcodebuild -exportArchive -archivePath build/CaloricSwift.xcarchive -exportPath build/TestFlight \
  -exportOptionsPlist "$caloric_export_options" -allowProvisioningUpdates "${args[@]}"
if [[ -n "${BUILD_NUMBER:-}" ]]; then
  node scripts/finish-testflight.mjs "$BUILD_NUMBER" ${CALORIC_RELEASE_NOTES:+"$CALORIC_RELEASE_NOTES"}
fi
