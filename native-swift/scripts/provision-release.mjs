#!/usr/bin/env node
// Save/renew distribution profiles privately. App Group registration is a one-time portal setup.
import { readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { requestApple } from './appstore-connect.mjs';

const targets = [
  { bundle: 'lol.mati.caloric.swift', id: 'K7N3BFR584', name: 'Caloric Swift' },
  { bundle: 'lol.mati.caloric.swift.CaloricWidget', id: 'H55574XFU9', name: 'Caloric Swift Widget' },
];
const group = 'group.lol.mati.caloric.swift';
const team = 'BQ7842UUHJ';
const configuration = process.env.CALORIC_SIGNING_CREDENTIALS || join(homedir(), '.config/caloric/signing.json');
const refresh = process.argv.includes('--refresh');

function privateWrite(path, contents) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, contents, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function metadata(path) {
  const xml = execFileSync('security', ['cms', '-D', '-i', path], { stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(execFileSync('python3', ['-c', `
import sys, json, plistlib, hashlib
p = plistlib.loads(sys.stdin.buffer.read())
e = p.get('Entitlements', {})
print(json.dumps({'uuid':p['UUID'], 'app':e.get('application-identifier'),
'team':e.get('com.apple.developer.team-identifier'),
'groups':e.get('com.apple.security.application-groups', []),
'cloud':e.get('com.apple.developer.icloud-container-identifiers', []),
'expires':p['ExpirationDate'].isoformat()+'Z',
'certificates':[hashlib.sha1(c).hexdigest().upper() for c in p['DeveloperCertificates']],
'development':e.get('get-task-allow', False), 'devices':p.get('ProvisionedDevices', [])}))
`], { input: xml, encoding: 'utf8' }));
}

function valid(profile, target, identity) {
  return profile.app === `${team}.${target.bundle}` && profile.team === team &&
    profile.groups.includes(group) && profile.certificates.includes(identity.toUpperCase()) &&
    Date.parse(profile.expires) > Date.now() + 7 * 86400000 && !profile.development && !profile.devices.length &&
    (target.bundle !== targets[0].bundle || profile.cloud.includes('iCloud.lol.mati.caloric.swift'));
}

try {
  const config = JSON.parse(readFileSync(configuration, 'utf8'));
  const identity = config.certificateSHA1;
  if (typeof identity !== 'string' || !/^[A-Fa-f0-9]{40}$/.test(identity)) throw new Error('Saved distribution identity is missing');
  const certificates = await requestApple('/v1/certificates?limit=200');
  const certificate = certificates.data.find(item => item.attributes.certificateContent &&
    createHash('sha1').update(Buffer.from(item.attributes.certificateContent, 'base64')).digest('hex').toUpperCase() === identity.toUpperCase() &&
    Date.parse(item.attributes.expirationDate) > Date.now() + 7 * 86400000);
  if (!certificate) throw new Error('The saved distribution certificate needs renewal before release');
  const profiles = {};
  for (const target of targets) {
    const existing = config.profiles?.[target.bundle];
    const related = await requestApple(`/v1/bundleIds/${target.id}/profiles?limit=200`);
    const candidate = !refresh && existing && existsSync(existing.path) &&
      related.data.some(item => item.id === existing.profileID && item.attributes.profileState === 'ACTIVE') &&
      valid(metadata(existing.path), target, identity);
    if (candidate) {
      profiles[target.bundle] = existing;
      continue;
    }
    let selected;
    for (const item of refresh ? [] : related.data) {
      if (item.attributes.profileState !== 'ACTIVE' || item.attributes.profileType !== 'IOS_APP_STORE') continue;
      const path = join(dirname(configuration), 'profiles', `${item.id}.mobileprovision`);
      privateWrite(path, Buffer.from(item.attributes.profileContent, 'base64'));
      const decoded = metadata(path);
      if (valid(decoded, target, identity)) {
        selected = { profileID: item.id, path, uuid: decoded.uuid };
        break;
      }
    }
    if (!selected) {
      const created = await requestApple('/v1/profiles', 'POST', { data: {
        type: 'profiles',
        attributes: { name: `${target.name} Release ${new Date().toISOString().slice(0, 10)} ${randomUUID().slice(0, 6)}`, profileType: 'IOS_APP_STORE' },
        relationships: { bundleId: { data: { type: 'bundleIds', id: target.id } },
          certificates: { data: [{ type: 'certificates', id: certificate.id }] } },
      } });
      const item = created.data;
      const path = join(dirname(configuration), 'profiles', `${item.id}.mobileprovision`);
      privateWrite(path, Buffer.from(item.attributes.profileContent, 'base64'));
      const decoded = metadata(path);
      if (!valid(decoded, target, identity)) {
        throw new Error(`Associate ${group} with ${target.bundle} in Apple Developer first. The distribution profile must include the widget App Group and the app's iCloud container.`);
      }
      selected = { profileID: item.id, path, uuid: decoded.uuid };
    }
    profiles[target.bundle] = selected;
  }
  privateWrite(configuration, JSON.stringify({ ...config, certificateID: certificate.id, profiles }, null, 2) + '\n');
  console.log('App and widget distribution profiles saved privately; App Group and iCloud entitlements verified.');
} catch (error) {
  console.error(`Release provisioning failed: ${error.message}`);
  process.exitCode = 1;
}
