#!/usr/bin/env python3
"""Prepare the saved local distribution identity without printing credentials."""
import json
import os
import plistlib
import shlex
import subprocess
from datetime import datetime, timezone
from pathlib import Path


def security(*args):
    result = subprocess.run(["security", *args], capture_output=True, text=True)
    if result.returncode:
        raise SystemExit("Could not prepare the saved signing keychain. Check the local signing configuration.")
    return result.stdout


config_path = Path(os.environ.get("CALORIC_SIGNING_CREDENTIALS", Path.home() / ".config/caloric/signing.json"))
if not config_path.exists():
    raise SystemExit("Save the local distribution signing configuration before releasing.")

try:
    config = json.loads(config_path.read_text())
    keychain = config["keychainPath"]
    security("unlock-keychain", "-p", config["password"], keychain)
    existing = shlex.split(security("list-keychains", "-d", "user"))
    if keychain not in existing:
        security("list-keychains", "-d", "user", "-s", *existing, keychain)
    profiles = config.get("profiles", {})
    bundles = {"lol.mati.caloric.swift": "APP", "lol.mati.caloric.swift.CaloricWidget": "WIDGET"}
    if not all(bundle in profiles for bundle in bundles):
        raise SystemExit("Run node scripts/provision-release.mjs after the one-time Apple App Group setup.")
    destination = Path.home() / "Library/Developer/Xcode/UserData/Provisioning Profiles"
    destination.mkdir(parents=True, exist_ok=True)
    settings = [f"CALORIC_SIGNING_IDENTITY = {config['certificateSHA1']}"]
    for bundle, name in bundles.items():
        saved = profiles[bundle]
        path = Path(saved["path"])
        decoded = subprocess.run(["security", "cms", "-D", "-i", str(path)], capture_output=True)
        if decoded.returncode:
            raise ValueError("Unreadable provisioning profile")
        profile = plistlib.loads(decoded.stdout)
        entitlements = profile["Entitlements"]
        expiration = profile["ExpirationDate"].replace(tzinfo=timezone.utc)
        if (profile["UUID"] != saved["uuid"] or expiration <= datetime.now(timezone.utc)
            or entitlements.get("application-identifier") != f"BQ7842UUHJ.{bundle}"
            or "group.lol.mati.caloric.swift" not in entitlements.get("com.apple.security.application-groups", [])):
            raise SystemExit("Provisioning profiles are missing required entitlements or expired; rerun scripts/provision-release.mjs.")
        installed = destination / f"{saved['uuid']}.mobileprovision"
        installed.write_bytes(path.read_bytes())
        installed.chmod(0o600)
        settings.append(f"CALORIC_{name}_PROFILE_UUID = {saved['uuid']}")
    Path("Config/Signing.xcconfig").write_text("\n".join(settings) + "\n")
    Path("Config/Signing.xcconfig").chmod(0o600)
    options = plistlib.loads(Path("Config/ExportOptions.plist").read_bytes())
    options.update({
        "signingStyle": "manual",
        "signingCertificate": config["certificateSHA1"],
        "provisioningProfiles": {bundle: profiles[bundle]["uuid"] for bundle in bundles},
    })
    output = Path("build/ExportOptionsLocalSigning.plist")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(plistlib.dumps(options))
    print(output)
except (KeyError, ValueError, OSError):
    raise SystemExit("Invalid local signing configuration. Check the saved signing file and profile.")
