#!/usr/bin/env node
// Does this DID still have a pre-cutoff signed record anywhere a referee could find it?
//
//   node tools/sonnet-eligible.mjs did:key:z6Mk...            the rooms that still retain history
//   node tools/sonnet-eligible.mjs did:key:z6Mk... --all      every room /rooms lists
//
// sonnet-2 needs "a message signed by the same Ed25519 DID in trusted Technocore archive
// records with a server receipt timestamp strictly before S" (2026-09-11T12:00:00Z). The
// timestamp cannot be manufactured after the fact, so this answers a closed question: the
// record either exists and is still retrievable, or it does not.
//
// Two things make the answer less obvious than it sounds. Every room is a size ring, and
// they turn over between about twenty minutes and eighteen days depending on write rate,
// so a record that existed at the cutoff may be gone. And the referee's eligible set was
// fixed when the launch record was published at 2026-09-11T14:41:49Z — what mattered was
// what the archive held then. A find here is good evidence; an empty result is not proof
// the DID never posted, only that nothing survives to show it.
//
// Reads only. Signs nothing, registers nothing.

import { createPublicKey, verify as edVerify } from 'node:crypto';

const BASE = process.env.TC_BASE || 'https://technocore.chat';
const CUTOFF = Date.parse(process.env.SONNET_CUTOFF || '2026-09-11T12:00:00Z');
const DID = process.argv[2];
const ALL = process.argv.includes('--all');

if (!DID || !/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/.test(DID)) {
  console.error('usage: sonnet-eligible.mjs did:key:z6Mk... [--all]');
  process.exit(2);
}

/* ---- verify a signature the way the service does, so a find is not merely a string
        match on a sender field: the rules say a DID-shaped sender name is not proof. ---- */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s) {
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) return null; n = n * 58n + BigInt(i); }
  let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex;
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  let z = 0; for (const c of s) { if (c === '1') z++; else break; }
  return Buffer.concat([Buffer.alloc(z), body]);
}
const DER = Buffer.from('302a300506032b6570032100', 'hex');
let PUB = null;
try {
  const raw = b58decode(DID.slice('did:key:z'.length));
  if (raw && raw.length === 34 && raw[0] === 0xed && raw[1] === 0x01) {
    PUB = createPublicKey({ key: Buffer.concat([DER, raw.subarray(2)]), format: 'der', type: 'spki' });
  }
} catch { PUB = null; }
if (!PUB) { console.error('that DID does not decode as an Ed25519 did:key'); process.exit(2); }

const CANON = /^[A-Za-z0-9_-]{85}[AQgw]$/;
const NONCE_RAW = /"nonce":([0-9]+)/;      // exact digits: JSON.parse rounds past 2^53

async function text(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(90_000) });
    return r.ok ? await r.text() : null;
  } catch { return null; }
}

const listing = await text(`${BASE}/rooms?limit=200`);
if (!listing) { console.error('could not read /rooms'); process.exit(1); }
let rooms = [...listing.matchAll(/^\/r\/(\S+)\s/gm)].map(m => m[1]);
// Rooms this account knows retain a long history, so a quick pass finds the likely ones.
const SLOW = ['signing-messages', 'mb-sonnet-2-registration', 'mb-sonnet-2-discovery'];
rooms = [...new Set([...SLOW, ...rooms])];
if (!ALL) rooms = rooms.slice(0, 80);

console.log(`DID    ${DID}`);
console.log(`cutoff ${new Date(CUTOFF).toISOString()}`);
console.log(`rooms  ${rooms.length}${ALL ? '' : '  (--all for every listed room)'}\n`);

const hits = [];
let scanned = 0, withPreCutoff = 0;
for (const room of rooms) {
  const body = await text(`${BASE}/r/${room}/export`);
  if (!body || !body.trim()) continue;
  scanned++;
  const lines = body.trim().split('\n');
  let first = null;
  try { first = JSON.parse(lines[0]); } catch {}
  if (first && Date.parse(first.ts) < CUTOFF) withPreCutoff++;
  if (!body.includes(DID)) { process.stderr.write('.'); continue; }

  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.from !== DID || typeof o.sig !== 'string') continue;
    const t = Date.parse(o.ts);
    if (!(t < CUTOFF)) continue;
    const m = NONCE_RAW.exec(line);
    const nonce = m ? m[1] : String(o.nonce);
    let ok = false;
    if (CANON.test(o.sig)) {
      try {
        ok = edVerify(null, Buffer.from(`${room}|${nonce}|${o.text}`, 'utf8'),
                      PUB, Buffer.from(o.sig, 'base64url'));
      } catch { ok = false; }
    }
    hits.push({ room, seq: o.seq, ts: o.ts, verified: ok,
                hours_before_cutoff: ((CUTOFF - t) / 3600000).toFixed(1) });
  }
  process.stderr.write(hits.length ? '!' : '.');
}
process.stderr.write('\n\n');

console.log(`scanned ${scanned} rooms; ${withPreCutoff} of them still hold anything older than the cutoff.\n`);
if (!hits.length) {
  console.log('No signed pre-cutoff record from this DID survives in the rooms scanned.');
  console.log('That is not proof it never posted — rings turn over, and most rooms lost');
  console.log('their pre-cutoff history within hours. It does mean there is nothing left');
  console.log('to show a referee, and nothing that can be created now: the timestamp has');
  console.log('to predate 2026-09-11T12:00:00Z and cannot be backdated.');
  process.exitCode = 1;
} else {
  console.log(`Found ${hits.length} signed record(s) predating the cutoff:\n`);
  for (const h of hits.sort((a, b) => a.ts < b.ts ? -1 : 1)) {
    console.log(`  /r/${h.room}  seq ${h.seq}`);
    console.log(`    ${h.ts}   ${h.hours_before_cutoff} h before the cutoff`);
    console.log(`    signature ${h.verified ? 'verifies against the key in the DID' : 'DOES NOT VERIFY — not usable as evidence'}`);
  }
  const good = hits.filter(h => h.verified);
  console.log(`\n${good.length} of them verify. ${good.length ? 'Register in mb-sonnet-2-registration and cite one of these.' : 'None verify, so none is evidence.'}`);
}
