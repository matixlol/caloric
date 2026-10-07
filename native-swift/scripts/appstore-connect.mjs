#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Credentials stay outside the repository. Tokens are short-lived and never printed.
export async function requestApple(path, method = 'GET', body) {
  if (!path?.startsWith('/v1/') || path.startsWith('//')) throw new Error('Expected an App Store Connect /v1/ path');
  const configPath = process.env.CALORIC_APPLE_CREDENTIALS || join(homedir(), '.config/caloric/apple.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'ES256', kid: config.keyID, typ: 'JWT' })}.${encode({
    iss: config.issuerID, iat: now - 5, exp: now + 600, aud: 'appstoreconnect-v1',
  })}`;
  const key = createPrivateKey(readFileSync(config.keyPath));
  const signature = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const response = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${unsigned}.${signature}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = response.status === 204 ? {} : await response.json();
  if (!response.ok) {
    const details = result.errors?.map(error => `${error.code}: ${error.title}`).join('; ') || 'Request rejected';
    throw new Error(`App Store Connect returned HTTP ${response.status}: ${details}`);
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [path, method = 'GET', bodyFile] = process.argv.slice(2);
  try {
    const result = await requestApple(path, method, bodyFile ? JSON.parse(readFileSync(bodyFile, 'utf8')) : undefined);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    console.error(`App Store Connect request failed: ${error.message}`);
    process.exitCode = 1;
  }
}
