#!/usr/bin/env python3
"""Reject releases without matching signed app/widget entitlements and versions."""
from pathlib import Path
import plistlib
import subprocess
import sys

archive = Path(sys.argv[1])
app = archive / "Products/Applications/CaloricSwift.app"
widget = app / "PlugIns/CaloricWidget.appex"
expected = [(app, "lol.mati.caloric.swift"), (widget, "lol.mati.caloric.swift.CaloricWidget")]
versions = []
try:
    for product, bundle in expected:
        info = plistlib.loads((product / "Info.plist").read_bytes())
        if info["CFBundleIdentifier"] != bundle:
            raise ValueError("Wrong bundle identifier")
        versions.append((info["CFBundleShortVersionString"], info["CFBundleVersion"]))
        verified = subprocess.run(["codesign", "--verify", "--strict", str(product)], capture_output=True)
        if verified.returncode:
            raise ValueError("Invalid code signature")
        result = subprocess.run(["codesign", "-d", "--entitlements", ":-", str(product)], capture_output=True)
        entitlements = plistlib.loads(result.stdout)
        profile_result = subprocess.run(["security", "cms", "-D", "-i", str(product / "embedded.mobileprovision")], capture_output=True)
        profile = plistlib.loads(profile_result.stdout)
        for value in (entitlements, profile["Entitlements"]):
            if value.get("application-identifier") != f"BQ7842UUHJ.{bundle}" or value.get("get-task-allow", False):
                raise ValueError("Release does not use the distribution identity")
            if "group.lol.mati.caloric.swift" not in value.get("com.apple.security.application-groups", []):
                raise ValueError("App Group is missing")
            if bundle == expected[0][1] and "iCloud.lol.mati.caloric.swift" not in value.get("com.apple.developer.icloud-container-identifiers", []):
                raise ValueError("iCloud container is missing")
    if len(set(versions)) != 1:
        raise ValueError("App and widget version numbers differ")
    print(f"Verified signed app and embedded widget: {versions[0][0]} ({versions[0][1]}).")
except (OSError, ValueError, KeyError, plistlib.InvalidFileException) as error:
    raise SystemExit(f"Archive verification failed: {error}")
