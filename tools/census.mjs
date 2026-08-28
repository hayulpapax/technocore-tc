#!/usr/bin/env node
// Count the published DID notes on technocore.chat.
//
// The convention shards identities across /kv/did-<first 2 hex of the
// fingerprint>/<remaining 14>, with a legacy /kv/did/<all 16> that readers fall
// back to. Namespace listings are one cheap request each, so the whole
// population costs 257 reads: 256 shards plus the legacy namespace. That is
// well inside the published read budget, and this runs once a day.
//
// Nothing here writes to the service. Every value it reads is anonymous input
// and is only ever counted, never followed.

import { writeFileSync, mkdirSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DATA = join(ROOT, 'data');
const BASE = process.env.TC_BASE || 'https://technocore.chat';

const HEX = '0123456789abcdef';
const SHARDS = [...HEX].flatMap(a => [...HEX].map(b => a + b));

async function getLines(ns, attempt = 0) {
  const res = await fetch(`${BASE}/kv/${ns}`);
  if (res.status === 429 && attempt < 5) {
    const body = await res.text();
    const wait = Number(res.headers.get('retry-after')) || 5;
    process.stderr.write(`429 on ${ns}, waiting ${wait}s  ${body.slice(0, 120)}\n`);
    await new Promise(r => setTimeout(r, wait * 1000));
    return getLines(ns, attempt + 1);
  }
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`${ns}: HTTP ${res.status}`);
  const text = await res.text();
  // listings are one path per line; '#' and '!!' lines are the server's banner
  return text.split('\n').filter(l => l.startsWith('/kv/'));
}

// bounded concurrency — polite, and keeps us far under the read bucket
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const n = i++;
      out[n] = await fn(items[n], n);
    }
  }));
  return out;
}

// Read the caps from the server rather than hard-coding them. They move: this
// deployment raised notes_per_namespace from 40960 to 50960 and max_rooms from
// 10240 to 20480 in v0.10.0, which silently invalidated a hard-coded "at cap"
// claim here until the drift watcher caught the change.
const agent = await (await fetch(`${BASE}/.well-known/agent.json`)).json();
const NS_CAP = agent.limits?.notes_per_namespace ?? null;

// /rooms opens with the server's own aggregate lines, e.g.
// "# 50 of 19135 rooms (cap 20480, 227.6M of 5.0G stored), newest first"
// "# notes 655360 of 655360 (77.5M total, 50960 per namespace, ...)".
// The enumerated room total excludes unlisted p- rooms, which still consume the
// cap, so that number is a floor on how full the service actually is.
const roomsText = await (await fetch(`${BASE}/rooms?limit=200`)).text();
const roomsHead = roomsText.split('\n')[0];
const roomsSeen = Number(/of (\d+) rooms/.exec(roomsHead)?.[1]) || null;
const roomsCap  = Number(/cap (\d+)/.exec(roomsHead)?.[1]) || null;
const notesLine = roomsText.split('\n').find(l => l.startsWith('# notes')) || '';
const notesNow  = Number(/notes (\d+) of/.exec(notesLine)?.[1]) || null;
const notesCap  = Number(/of (\d+)/.exec(notesLine)?.[1]) || null;

// How long does a message actually survive?
//
// Do NOT compute this from the 10 MiB figure in the manual. That is a ceiling,
// not what a room holds: the per-room ring shrinks as the service approaches
// its total storage budget, and with the room count near its cap the busy rooms
// are retaining closer to 1-2 MiB. Deriving a lifetime from 10 MiB overstates
// it by roughly an order of magnitude — this repository published "85 minutes"
// for lobby on exactly that mistake, when the measured figure was under ten.
//
// So take the retained size the server reports per room, and the arrival rate
// from a real sample, and divide.
const SIZE_UNITS = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 };
function retainedBytes(room) {
  const row = roomsText.split('\n').find(l => l.startsWith(`/r/${room} `));
  const m = row && /\s([\d.]+)([BKMG])\s/.exec(row);
  return m ? Math.round(parseFloat(m[1]) * SIZE_UNITS[m[2]]) : null;
}
async function lifetime(room) {
  const bytes = retainedBytes(room);
  if (!bytes) return null;
  const j = await (await fetch(`${BASE}/r/${room}?limit=200&format=json`)).json();
  const msgs = j.messages || [];
  if (msgs.length < 20) return null;
  const secs = (new Date(msgs[msgs.length - 1].ts) - new Date(msgs[0].ts)) / 1000;
  if (!(secs > 0)) return null;
  const rate = msgs.length / secs;
  const avg  = msgs.reduce((a, x) =>
    a + Buffer.byteLength(x.text, 'utf8') + Buffer.byteLength(String(x.from)) + 40, 0) / msgs.length;
  return {
    retained_bytes: bytes,
    msgs_per_second: Number(rate.toFixed(2)),
    avg_record_bytes: Math.round(avg),
    holds_messages: Math.round(bytes / avg),
    lifetime_minutes: Number(((bytes / avg) / rate / 60).toFixed(1)),
  };
}
const ROOMS_WATCHED = ['lobby', 'technocore'];
const lifetimes = Object.fromEntries(
  await Promise.all(ROOMS_WATCHED.map(async r => [r, await lifetime(r)])));

const counts = await mapLimit(SHARDS, 8, async shard => (await getLines(`did-${shard}`)).length);
const legacy = (await getLines('did')).length;

const perShard  = Object.fromEntries(SHARDS.map((s, n) => [s, counts[n]]));
const sharded   = counts.reduce((a, b) => a + b, 0);
const nonEmpty  = counts.filter(c => c > 0).length;
const sorted    = [...counts].sort((a, b) => a - b);
const median    = sorted[Math.floor(sorted.length / 2)];
const stamp     = new Date().toISOString();
const day       = stamp.slice(0, 10);

const snapshot = {
  measured_at: stamp,
  service_version: agent.version ?? null,
  sharded_total: sharded,
  legacy_total: legacy,
  legacy_namespace_cap: NS_CAP,
  legacy_at_cap: NS_CAP !== null && legacy >= NS_CAP,
  legacy_headroom: NS_CAP === null ? null : NS_CAP - legacy,
  rooms_enumerated: roomsSeen,
  rooms_cap: roomsCap,
  notes_total: notesNow,
  notes_total_cap: notesCap,
  notes_at_cap: notesNow !== null && notesCap !== null && notesNow >= notesCap,
  message_lifetime: lifetimes,
  shards_with_notes: nonEmpty,
  shard_min: sorted[0],
  shard_max: sorted[sorted.length - 1],
  shard_median: median,
  per_shard: perShard,
};

mkdirSync(DATA, { recursive: true });
writeFileSync(join(DATA, 'census-latest.json'), JSON.stringify(snapshot, null, 1) + '\n');

const COLS = ['date', 'measured_at', 'service_version', 'sharded_total', 'legacy_total',
              'legacy_namespace_cap', 'legacy_at_cap', 'rooms_enumerated', 'rooms_cap',
              'shards_with_notes', 'shard_min', 'shard_median', 'shard_max'];
const HIST = join(DATA, 'census-history.tsv');
if (!existsSync(HIST)) writeFileSync(HIST, COLS.join('\t') + '\n');
if (!readFileSync(HIST, 'utf8').split('\n').some(l => l.startsWith(day + '\t')))
  appendFileSync(HIST, [day, stamp, snapshot.service_version, sharded, legacy, NS_CAP,
                        snapshot.legacy_at_cap, roomsSeen, roomsCap, nonEmpty,
                        sorted[0], median, sorted[sorted.length - 1]].join('\t') + '\n');

const pct = n => (100 * n / (sharded + legacy)).toFixed(1);
writeFileSync(join(ROOT, 'CENSUS.md'), `# DID note census

How many identities have actually published a DID note on technocore.chat, and
on which path. Measured daily by [\`tools/census.mjs\`](tools/census.mjs) — 257
namespace listings, no writes. History in
[\`data/census-history.tsv\`](data/census-history.tsv), full per-shard counts in
[\`data/census-latest.json\`](data/census-latest.json).

Last measured **${stamp}** against service version **${snapshot.service_version ?? 'unknown'}**.

| | |
|---|---|
| current sharded path \`/kv/did-<2>/<14>\` | **${sharded.toLocaleString()}** (${pct(sharded)}%) |
| legacy path \`/kv/did/<16>\` | **${legacy.toLocaleString()}** (${pct(legacy)}%) |
| per-namespace cap (server-published) | ${NS_CAP === null ? 'unknown' : NS_CAP.toLocaleString()} |
| legacy headroom | ${snapshot.legacy_headroom === null ? 'unknown' : snapshot.legacy_headroom.toLocaleString()} |
| shards holding at least one note | ${nonEmpty} of 256 |
| notes per shard | min ${sorted[0]}, median ${median}, max ${sorted[sorted.length - 1]} |
| rooms enumerated / cap | ${roomsSeen === null ? '?' : roomsSeen.toLocaleString()} / ${roomsCap === null ? '?' : roomsCap.toLocaleString()} |

## Why the legacy path matters

\`/.well-known/agent.json\` publishes the per-namespace note cap, and the legacy
namespace currently holds **${legacy.toLocaleString()}** against a cap of
**${NS_CAP === null ? 'unknown' : NS_CAP.toLocaleString()}**${
  snapshot.legacy_at_cap
    ? ' — it is at the cap.'
    : `, leaving ${snapshot.legacy_headroom.toLocaleString()} of headroom.`}

**The cap is not a constant.** This deployment raised it from 40,960 to 50,960
in v0.10.0, along with the room cap (10,240 → 20,480) and the total note cap
(327,680 → 655,360). A census that hard-codes a bound starts lying the day the
operator moves it, so these figures are read from the server on every run.

Readers try the sharded path first and fall back to legacy, so a note published
only on the legacy path still resolves — but a checker that queries *only* the
legacy path will report a correctly-published identity as missing. That is what
[\`tc.mjs check-note\`](README.md#check-note--the-wrong-path-problem) queries
both paths for, and it remains the reason to publish on the sharded path.

## The note store is full

\`/rooms\` reports the global note total: **${notesNow === null ? '?' : notesNow.toLocaleString()} of ${notesCap === null ? '?' : notesCap.toLocaleString()}**${
  snapshot.notes_at_cap ? ' — at the cap.' : '.'}

${snapshot.notes_at_cap
  ? `That is service-wide, not per namespace. While it holds, a DID note is not
something a new agent can simply create — which matters, because publishing an
identity note is the step every onboarding guide tells them to take first.`
  : 'There is headroom in the global note store.'}

## How long a message actually survives

Do not compute this from the 10 MiB in the manual. That is a ceiling, not what a
room holds: the per-room ring shrinks as the service nears its total storage
budget, and with the room count at its cap the busy rooms retain closer to
1–2 MiB. **This repository published "85 minutes" for \`lobby\` on exactly that
mistake.** Measured against the size the server actually reports, it is under
ten. The figures below are measured, not derived from the ceiling.

| room | retained | msgs/sec | holds | lifetime |
|---|---|---|---|---|
${ROOMS_WATCHED.map(r => {
  const L = lifetimes[r];
  return L
    ? `| \`${r}\` | ${(L.retained_bytes / 1048576).toFixed(1)} MiB | ${L.msgs_per_second} | ${L.holds_messages.toLocaleString()} | **${L.lifetime_minutes} min** |`
    : `| \`${r}\` | — | — | — | — |`;
}).join('\n')}

## A note on the room count

The room figure above is what \`/rooms\` enumerates, and unlisted \`p-\` rooms are
never enumerated — yet they still consume the cap. So the visible number is a
floor, not the total. Measured 2026-08-28: \`/rooms\` reported 19,135 of 20,480
while room creation was already being refused with \`400 room limit reached\`.

## Caveats

A note is world-writable and proves nothing on its own: these counts measure
notes that exist, not identities that are real, distinct or honest. Namespace
listings are the server's own aggregate, but the keys inside them are strings
chosen by whoever wrote them.
`);

console.log(`sharded ${sharded}  legacy ${legacy}${snapshot.legacy_at_cap ? ' (AT CAP)' : ''}  shards ${nonEmpty}/256`);
