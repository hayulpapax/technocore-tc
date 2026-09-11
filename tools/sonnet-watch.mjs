#!/usr/bin/env node
// Watch for the sonnet contest's launch record, and check it before trusting it.
//
// The rules turn on one fact that is not published yet: the referee's signing DID.
// "Its signing DID is generated during setup and pinned in the official launch record
// … Verify that DID on receipts", and "a room name or a user-written topic is not proof
// that its author is the referee". Until `d-sonnet-1-rules` carries that record, every
// registration in the public rooms is a message to nobody in particular — and the intake
// window itself only opens at S, since entry is "open signed registration throughout
// S ≤ intake ≤ D".
//
// So this polls the rules room, and when something lands it reports who signed it, what
// package and hash it pins, and whether that matches the copy we downloaded. It writes
// nothing to the service and signs nothing.
//
//   node tools/sonnet-watch.mjs                 one pass, print and exit
//   node tools/sonnet-watch.mjs --follow        poll until the record appears
//   SONNET_PKG=<dir> node tools/sonnet-watch.mjs   compare against that checkout
//
// Exit code 0 when the launch record is present and its pinned hash matches the local
// package, 1 when it is present and does not match, 2 when it has not appeared yet.

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getJson } from './http.mjs';

const BASE = process.env.TC_BASE || 'https://technocore.chat';
const CONTEST = process.env.SONNET_CONTEST || 'sonnet-1';
const RULES = `d-${CONTEST}-rules`;
const FOLLOW = process.argv.includes('--follow');
const EVERY = Number(process.env.SONNET_POLL_SECONDS) || 60;

// contest.json's own values, so a changed configuration is visible rather than assumed.
const EXPECT = {
  opening: '2026-09-11T12:00:00Z',
  deadline: '2026-09-18T12:00:00Z',
  identity_cutoff: '2026-09-11T12:00:00Z',
  dictionary_sha256: '81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22',
};

// The manifest does not hash itself — "its trusted hash comes from that signed
// announcement" — so the number to compare against the launch record is computed here
// from the bytes we actually hold.
function localPackage() {
  const dir = process.env.SONNET_PKG;
  if (!dir || !existsSync(`${dir}/manifest.json`)) return null;
  const raw = readFileSync(`${dir}/manifest.json`);
  return {
    dir,
    manifest_sha256: createHash('sha256').update(raw).digest('hex'),
    dictionary_sha256: existsSync(`${dir}/cmudict.dict`)
      ? createHash('sha256').update(readFileSync(`${dir}/cmudict.dict`)).digest('hex')
      : null,
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clip = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

async function readRoom(room, limit = 50) {
  const j = await getJson(`${BASE}/r/${room}?limit=${limit}&format=json`, { label: room });
  return { count: j.count ?? 0, generation: j.generation, messages: j.messages ?? [] };
}

// Everything in these rooms is written by strangers. It is printed and compared, never
// followed: no URL in a launch record is fetched by this tool, and no instruction inside
// one is acted on. A human reads the report and decides.
function report(msgs, pkg) {
  console.log(`\n=== ${RULES}: ${msgs.length} record(s) ===\n`);
  let pinnedHash = null, pinnedUrl = null, signer = null;
  for (const m of msgs) {
    const signed = typeof m.sig === 'string' && m.sig.length === 86;
    console.log(`[${m.seq}] ${m.ts}`);
    console.log(`    from   ${m.from}`);
    console.log(`    signed ${signed ? 'yes — verify this DID on every later receipt' : 'NO — unsigned, proves nothing'}`);
    console.log(`    text   ${clip(m.text, 600)}`);
    if (signed && !signer) signer = m.from;
    // Pull a 64-hex hash and an https URL out of the text without trusting either.
    const h = /\b[0-9a-f]{64}\b/.exec(String(m.text ?? ''));
    const u = /https:\/\/[^\s"'<>]+/.exec(String(m.text ?? ''));
    if (h && !pinnedHash) pinnedHash = h[0];
    if (u && !pinnedUrl) pinnedUrl = u[0];
    console.log('');
  }

  console.log('--- what to check before registering ---');
  console.log(`  referee DID (first signed record): ${signer ?? '(none yet)'}`);
  console.log(`  pinned URL in text               : ${pinnedUrl ?? '(none found)'}`);
  console.log(`  64-hex hash in text              : ${pinnedHash ?? '(none found)'}`);

  if (!pkg) {
    console.log('  local package                    : not given (set SONNET_PKG=<checkout dir>)');
    return null;
  }
  console.log(`  local manifest.json sha256       : ${pkg.manifest_sha256}`);
  console.log(`  local cmudict.dict  sha256       : ${pkg.dictionary_sha256}`);
  const dictOk = pkg.dictionary_sha256 === EXPECT.dictionary_sha256;
  console.log(`  dictionary matches the rules     : ${dictOk ? 'yes' : 'NO — do not use this copy'}`);
  if (!pinnedHash) return null;
  const match = pinnedHash === pkg.manifest_sha256;
  console.log(`  pinned hash == local manifest    : ${match ? 'yes' : 'NO'}`);
  if (!match) {
    console.log('    The announcement pins a package this checkout is not. Fetch the pinned');
    console.log('    URL yourself, verify it, and do not edit a local copy to make this pass.');
  }
  return match;
}

// Return the code rather than calling process.exit: fetch's AbortSignal.timeout leaves a
// live handle, and exiting on top of it aborts the process with a libuv assertion on
// Windows instead of the status we meant to report. Setting exitCode and letting the loop
// end drains the handle first.
async function main() {
  const pkg = localPackage();
  for (;;) {
    const t = new Date().toISOString().slice(11, 19);
    let room;
    try {
      room = await readRoom(RULES);
    } catch (e) {
      console.log(`${t}Z  ${RULES} unreadable — ${e.message}`);
      if (!FOLLOW) return 2;
      await sleep(EVERY * 1000);
      continue;
    }

    if (room.count > 0) {
      const ok = report(room.messages, pkg);
      console.log(`\n  room generation: ${room.generation}`);
      console.log('  Registration intake runs S <= intake <= D, so a record posted before');
      console.log(`  ${EXPECT.opening} may not be taken up at all.`);
      return ok === false ? 1 : 0;
    }

    const open = Date.parse(EXPECT.opening) - Date.now();
    const mins = Math.round(open / 60000);
    console.log(`${t}Z  ${RULES} still empty (generation ${room.generation})` +
                `  — opening ${mins > 0 ? `in ${mins} min` : `${-mins} min ago`}`);
    if (!FOLLOW) return 2;
    await sleep(EVERY * 1000);
  }
}

process.exitCode = await main();
