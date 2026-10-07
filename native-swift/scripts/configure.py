#!/usr/bin/env python3
"""Copy public mobile configuration locally; never copy backend secrets or commit account settings."""
import os
from pathlib import Path

root = Path(__file__).resolve().parents[1]
values = {}
source = root.parent / 'mobile/.env.local'
if source.exists():
    for line in source.read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            values[key] = value.strip().strip('\"\'')
backend = os.environ.get('CALORIC_BACKEND_URL', values.get('EXPO_PUBLIC_BACKEND_URL', 'https://backend.caloric.mati.lol'))
lines = [f'CALORIC_BACKEND_URL = {backend.replace("://", ":/$()/")}']
target = root / 'Config/Local.xcconfig'
if target.exists():
    lines += [line for line in target.read_text().splitlines() if line.startswith('DEVELOPMENT_TEAM =')]
if os.environ.get('APPLE_TEAM_ID'):
    lines = [line for line in lines if not line.startswith('DEVELOPMENT_TEAM =')]
    lines.append(f'DEVELOPMENT_TEAM = {os.environ["APPLE_TEAM_ID"]}')
target.write_text('\n'.join(lines) + '\n')
print('Local backend and signing configuration written; authentication uses Better Auth.')
