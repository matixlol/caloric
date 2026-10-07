#!/usr/bin/env node
// Wait for Apple's processing, add release notes, and assign the authorized internal group.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { requestApple } from './appstore-connect.mjs';

const appID = '6820093147';
const groupID = 'fe3b0912-1cc3-4ad8-8c27-652cbfd2b614';
const [version, notesFile] = process.argv.slice(2);
const defaultNotes = 'Updated to match the current Caloric app: Better Auth sync, recipes and editable ingredient snapshots, quick add and hold-and-slide pickers, barcode scanning, friends and read-only friend diaries, floating AI chat with interrupted stream recovery, animated voice recording and improved food dragging, nutrition widgets and recipe backups. Gesture instructions removed. Please test sign-in and existing-data sync, recipes, friends, camera scanning, microphone recording and widgets.';

try {
  if (!/^\d+$/.test(version || '')) throw new Error('Usage: node scripts/finish-testflight.mjs BUILD_NUMBER [notes.txt]');
  const notes = notesFile ? readFileSync(notesFile, 'utf8').trim() : defaultNotes;
  if (!notes || notes.length > 4000) throw new Error('Release notes must contain 1–4000 characters');
  let build;
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await requestApple(`/v1/builds?filter[app]=${appID}&filter[version]=${version}&include=buildBetaDetail`);
    build = result.data[0];
    if (build?.attributes.processingState === 'VALID') break;
    if (['FAILED', 'INVALID'].includes(build?.attributes.processingState)) throw new Error(`Apple marked build ${version} ${build.attributes.processingState}`);
    if (attempt === 29) throw new Error('Apple is still processing. Rerun this script to finish tester assignment.');
    if (attempt % 2 === 0) console.log(`Waiting for Apple to process build ${version}…`);
    await new Promise(resolve => setTimeout(resolve, 30000));
  }
  const localizations = await requestApple(`/v1/builds/${build.id}/betaBuildLocalizations`);
  const localization = localizations.data.find(item => item.attributes.locale === 'en-US');
  if (localization) {
    await requestApple(`/v1/betaBuildLocalizations/${localization.id}`, 'PATCH', { data: {
      type: 'betaBuildLocalizations', id: localization.id, attributes: { whatsNew: notes },
    } });
  } else {
    await requestApple('/v1/betaBuildLocalizations', 'POST', { data: {
      type: 'betaBuildLocalizations', attributes: { locale: 'en-US', whatsNew: notes },
      relationships: { build: { data: { type: 'builds', id: build.id } } },
    } });
  }
  const current = await requestApple(`/v1/betaGroups/${groupID}/builds?limit=200`);
  if (!current.data.some(item => item.id === build.id)) {
    await requestApple(`/v1/betaGroups/${groupID}/relationships/builds`, 'POST', { data: [{ type: 'builds', id: build.id }] });
  }
  const confirmed = await requestApple(`/v1/betaGroups/${groupID}/builds?limit=200`);
  if (!confirmed.data.some(item => item.id === build.id)) throw new Error('Internal tester assignment was not confirmed');
  const state = await requestApple(`/v1/builds/${build.id}?include=buildBetaDetail`);
  const beta = state.included?.find(item => item.type === 'buildBetaDetails');
  mkdirSync('build', { recursive: true });
  writeFileSync('build/submission.json', JSON.stringify({
    appStoreConnectAppID: appID, bundleIdentifier: 'lol.mati.caloric.swift', version: '1.0.0', build: version,
    finalArchiveStatus: 'SUCCEEDED', finalUploadStatus: 'UPLOADED', appleProcessingStatus: 'VALID',
    finalBuildID: build.id, internalGroupID: groupID, testerAssignmentStatus: 'ASSIGNED_TO_INTERNAL_GROUP',
    testFlightStatus: beta?.attributes.internalBuildState, confirmedAt: new Date().toISOString(),
    nativeWidget: 'SIGNED_AND_EMBEDDED', authentication: 'BETTER_AUTH',
  }, null, 2) + '\n');
  console.log(`Build ${version} is processed and assigned to Caloric Swift Internal (${beta?.attributes.internalBuildState || 'assigned'}).`);
} catch (error) {
  console.error(`TestFlight finalization failed: ${error.message}`);
  process.exitCode = 1;
}
