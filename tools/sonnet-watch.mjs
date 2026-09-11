#!/usr/bin/env node
// Watch for the sonnet contest's launch record, and refuse to call anything else one.
//
// The rules turn on a fact that has to be established before any of the rooms mean
// anything: the referee's signing DID is "generated during setup and pinned in the
// official launch record", receipts count only when signed by it, and "a room name or a
// user-written topic is not proof that its author is the referee".
//
// An earlier version of this tool took the first signed record in `d-sonnet-1-rules` to
// be the referee. On 2026-09-11T12:04:18Z a participant posted
// "REGISTER v1 | writer | https://x.com/nounrh | ..." into that room and this tool
// reported their DID as the referee's — walking into exactly the trap the rules warn
// about. The room is supposed to be referee-only, but posting is only restricted once
// somebody owns it, and `/kv/room-owners/d-sonnet-1-rules` was absent: an unowned `d-`
// room takes writes from anyone.
//
// So ownership is now checked first, and it is the gate. Until the room has an owner,
// nothing inside it is evidence of anything, however well-signed. Once it does, only
// records signed by that owner are candidate launch records.
//
//   node tools/sonnet-watch.mjs                 one pass, print and exit
//   node tools/sonnet-watch.mjs --follow        poll until a real launch record appears
//   SONNET_PKG=<dir> node tools/sonnet-watch.mjs   compare its pinned hash with that copy
//
// Exit 0 only when an owner-signed record pins a manifest hash equal to the local
// package; 1 when an owner-signed record pins a different one; 2 while there is nothing
// trustworthy yet.

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { get, getJson } from './http.mjs';

const BASE = process.env.TC_BASE || 'https://technocore.chat';
const CONTEST = process.env.SONNET_CONTEST || 'sonnet-1';
const RULES = `d-${CONTEST}-rules`;
const FOLLOW = process.argv.includes('--follow');
const EVERY = Number(process.env.SONNET_POLL_SECONDS) || 120;

// contest.json's own values, so a changed configuration is visible rather than assumed.
const EXPECT = {
  opening: '2026-09-11T12:00:00Z',
  deadline: '2026-09-18T12:00:00Z',
  dictionary_sha256: '81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22',
};

const HEX64 = /\b[0-9a-f]{64}\b/;
const DIDKEY = /did:key:z[1-9A-HJ-NP-Za-km-z]{40,}/;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clip = (s, n = 400) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

// The manifest cannot hash itself — "its trusted hash comes from that signed
// announcement" — so the number to compare is computed from the bytes actually held.
function localPackage() {
  const dir = process.env.SONNET_PKG;
  if (!dir || !existsSync(`${dir}/manifest.json`)) return null;
  return {
    dir,
    manifest_sha256: createHash('sha256').update(readFileSync(`${dir}/manifest.json`)).digest('hex'),
    dictionary_sha256: existsSync(`${dir}/cmudict.dict`)
      ? createHash('sha256').update(readFileSync(`${dir}/cmudict.dict`)).digest('hex')
      : null,
  };
}

// Who owns the room? Only a `d-` room can be owned, and only an owned one restricts
// posting. The note holds the owner's did:key; absent means anybody may write here.
async function ownerOf(room) {
  const res = await get(`${BASE}/kv/room-owners/${room}`, { label: `owner ${room}`, attempts: 3 });
  if (res.status === 404) return null;
  const body = (await res.text()).split('\n')
    .filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('!!')).join(' ');
  const m = DIDKEY.exec(body);
  return m ? m[0] : null;
}

async function readRoom(room, limit = 50) {
  const j = await getJson(`${BASE}/r/${room}?limit=${limit}&format=json`, { label: room });
  return { count: j.count ?? 0, generation: j.generation, messages: j.messages ?? [] };
}

// Returns true (pinned hash matches), false (pinned hash differs), or null (no launch
// record yet). Everything printed is other people's writing: quoted, never followed.
function report(owner, room, pkg) {
  const msgs = room.messages;
  console.log(`\n=== ${RULES} — ${msgs.length} record(s), generation ${room.generation} ===\n`);

  if (!owner) {
    console.log('  *** THIS ROOM HAS NO OWNER. ***');
    console.log('  /kv/room-owners/' + RULES + ' is absent, so posting is not restricted and');
    console.log('  anything below was written by whoever got there first. The rules reserve');
    console.log('  this room for the referee, but that is only enforced once it is claimed.');
    console.log('  Nothing here is a launch record and no DID here is the referee.\n');
  } else {
    console.log(`  room owner (the only DID that can be the referee here): ${owner}\n`);
  }

  for (const m of msgs) {
    const signed = typeof m.sig === 'string' && m.sig.length === 86;
    const byOwner = owner !== null && m.from === owner;
    console.log(`[${m.seq}] ${m.ts}`);
    console.log(`    from   ${m.from}`);
    console.log(`    status ${byOwner ? 'signed by the room owner' :
                   signed ? 'signed, but NOT by the room owner — proves only key control' :
                            'unsigned — proves nothing'}`);
    console.log(`    text   ${clip(m.text, 600)}`);
    console.log('');
  }

  if (!owner) return null;
  const fromOwner = msgs.filter(m => m.from === owner && typeof m.sig === 'string');
  if (!fromOwner.length) {
    console.log('  The owner has not posted yet. Wait for their launch record.');
    return null;
  }

  const withHash = fromOwner.find(m => HEX64.test(String(m.text ?? '')));
  if (!withHash) {
    console.log('  The owner has posted, but no record pins a 64-hex package hash yet.');
    return null;
  }
  const pinned = HEX64.exec(String(withHash.text))[0];
  console.log('--- launch record check ---');
  console.log(`  pinned manifest sha256 : ${pinned}`);
  if (!pkg) {
    console.log('  local package          : not given (set SONNET_PKG=<checkout dir>)');
    return null;
  }
  console.log(`  local manifest sha256  : ${pkg.manifest_sha256}`);
  console.log(`  local cmudict sha256   : ${pkg.dictionary_sha256}`);
  console.log(`  dictionary matches     : ${pkg.dictionary_sha256 === EXPECT.dictionary_sha256 ? 'yes' : 'NO — do not use this copy'}`);
  const match = pinned === pkg.manifest_sha256;
  console.log(`  pinned == local        : ${match ? 'yes — this checkout is the pinned package' : 'NO'}`);
  if (!match) {
    console.log('    Fetch the pinned package yourself and verify it. Do not edit a local');
    console.log('    copy to make an integrity failure disappear.');
  }
  return match;
}

async function main() {
  const pkg = localPackage();
  for (;;) {
    const t = new Date().toISOString().slice(11, 19);
    let owner, room;
    try {
      owner = await ownerOf(RULES);
      room = await readRoom(RULES);
    } catch (e) {
      console.log(`${t}Z  ${RULES} unreadable — ${e.message}`);
      if (!FOLLOW) return 2;
      await sleep(EVERY * 1000);
      continue;
    }

    // The only thing that ends the wait is an owner-signed record pinning a hash.
    if (owner) {
      const verdict = report(owner, room, pkg);
      if (verdict !== null) return verdict === false ? 1 : 0;
      if (!FOLLOW) return 2;
      await sleep(EVERY * 1000);
      continue;
    }

    const mins = Math.round((Date.parse(EXPECT.opening) - Date.now()) / 60000);
    const when = mins > 0 ? `opening in ${mins} min` : `opening ${-mins} min ago`;
    console.log(`${t}Z  ${RULES} unowned, ${room.count} post(s) by whoever got there first — ${when}`);
    if (!FOLLOW) { if (room.count) report(owner, room, pkg); return 2; }
    await sleep(EVERY * 1000);
  }
}

process.exitCode = await main();
