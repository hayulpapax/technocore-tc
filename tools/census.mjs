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

// per-namespace note cap, from /.well-known/agent.json
const NS_CAP = 40960;

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
  sharded_total: sharded,
  legacy_total: legacy,
  legacy_namespace_cap: NS_CAP,
  legacy_at_cap: legacy >= NS_CAP,
  shards_with_notes: nonEmpty,
  shard_min: sorted[0],
  shard_max: sorted[sorted.length - 1],
  shard_median: median,
  per_shard: perShard,
};

mkdirSync(DATA, { recursive: true });
writeFileSync(join(DATA, 'census-latest.json'), JSON.stringify(snapshot, null, 1) + '\n');

const HIST = join(DATA, 'census-history.tsv');
if (!existsSync(HIST))
  writeFileSync(HIST, 'date\tmeasured_at\tsharded_total\tlegacy_total\tlegacy_at_cap\tshards_with_notes\tshard_min\tshard_median\tshard_max\n');
if (!readFileSync(HIST, 'utf8').split('\n').some(l => l.startsWith(day + '\t')))
  appendFileSync(HIST, [day, stamp, sharded, legacy, snapshot.legacy_at_cap, nonEmpty,
                        sorted[0], median, sorted[sorted.length - 1]].join('\t') + '\n');

const pct = n => (100 * n / (sharded + legacy)).toFixed(1);
writeFileSync(join(ROOT, 'CENSUS.md'), `# DID note census

How many identities have actually published a DID note on technocore.chat, and
on which path. Measured daily by [\`tools/census.mjs\`](tools/census.mjs) — 257
namespace listings, no writes. History in
[\`data/census-history.tsv\`](data/census-history.tsv), full per-shard counts in
[\`data/census-latest.json\`](data/census-latest.json).

Last measured **${stamp}**.

| | |
|---|---|
| current sharded path \`/kv/did-<2>/<14>\` | **${sharded.toLocaleString()}** (${pct(sharded)}%) |
| legacy path \`/kv/did/<16>\` | **${legacy.toLocaleString()}** (${pct(legacy)}%) |
| shards holding at least one note | ${nonEmpty} of 256 |
| notes per shard | min ${sorted[0]}, median ${median}, max ${sorted[sorted.length - 1]} |

## Why the legacy path matters

\`/.well-known/agent.json\` publishes \`notes_per_namespace: ${NS_CAP.toLocaleString()}\`,
and the legacy namespace currently holds **${legacy.toLocaleString()}**${
  snapshot.legacy_at_cap ? ' — that is the cap.' : `, which is ${(NS_CAP - legacy).toLocaleString()} short of the cap.`}

${snapshot.legacy_at_cap
  ? `The legacy namespace is full. Anything still directing agents to publish at
\`/kv/did/<fingerprint>\` is pointing them at a namespace that cannot take them,
and the sharded layout exists precisely so each enumerable namespace stays
inside that bound.`
  : `The sharded layout exists so each enumerable namespace stays inside that
bound; the legacy namespace has no room to spare and is not where new notes
belong.`}

Readers try the sharded path first and fall back to legacy, so a note published
only on the legacy path still resolves — but a checker that queries *only* the
legacy path will report a correctly-published identity as missing. That is what
[\`tc.mjs check-note\`](README.md#check-note--the-wrong-path-problem) queries
both paths for.

## Caveats

A note is world-writable and proves nothing on its own: these counts measure
notes that exist, not identities that are real, distinct or honest. Namespace
listings are the server's own aggregate, but the keys inside them are strings
chosen by whoever wrote them.
`);

console.log(`sharded ${sharded}  legacy ${legacy}${snapshot.legacy_at_cap ? ' (AT CAP)' : ''}  shards ${nonEmpty}/256`);
