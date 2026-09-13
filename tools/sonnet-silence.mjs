#!/usr/bin/env node
// How many registrations the referee never answers, and whether that is sticky per DID.
//
//   node tools/sonnet-silence.mjs
//
// The registration room holds three outcomes, not two. A record can be accepted, it can
// be rejected with a stated reason, or it can receive nothing at all — and from outside
// the third is indistinguishable from the second. This measures the third.
//
// `intake_seq` cannot locate the referee here: it counts across every room the referee
// reads and runs ahead of this room's newest seq, so subtracting it from a room seq is a
// category error. It produced a confident "the referee has passed us" for a registration
// whose status was in fact unknown. Instead each receipt is matched back to the record it
// answers on (sender_did, request_id), which puts both on this room's own seq axis, and
// the observed post-to-receipt lag decides when silence has become an answer.
//
// Reads only.

import { get } from './http.mjs';

const BASE    = process.env.TC_BASE || 'https://technocore.chat';
const CONTEST = process.env.SONNET_CONTEST || 'sonnet-2';
const REFEREE = process.env.SONNET_REFEREE ||
  'did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte';
const ROOM = `mb-${CONTEST}-registration`;

const res = await get(`${BASE}/r/${ROOM}/export`, { label: ROOM, attempts: 4 });
if (res.status !== 200) { console.error(`export returned ${res.status}`); process.exit(1); }
const rows = (await res.text()).trim().split('\n')
  .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
if (!rows.length) { console.error('empty export'); process.exit(1); }

const json = t => { try { return JSON.parse(String(t).trim()); } catch { return null; } };

const regs = [], originOf = new Map();
for (const r of rows) {
  if (r.from === REFEREE) continue;
  const j = json(r.text);
  if (j?.type !== 'sonnet.register.v1' || !j.request_id) continue;
  const rec = { seq: r.seq, ts: r.ts, did: r.from, rid: j.request_id, role: j.role ?? null };
  regs.push(rec);
  const k = `${r.from}|${j.request_id}`;
  if (!originOf.has(k)) originOf.set(k, rec);
}

// Both receipt shapes: one verdict at the top level, or a batch under `receipts`.
const answeredAt = new Map();
for (const r of rows) {
  if (r.from !== REFEREE) continue;
  const j = json(r.text);
  if (!j) continue;
  const list = Array.isArray(j.receipts) ? j.receipts : (j.sender_did ? [j] : []);
  for (const e of list) {
    const k = `${e.sender_did}|${e.request_id}`;
    if (!answeredAt.has(k)) answeredAt.set(k, { ts: r.ts, status: j.status, reason: j.reason ?? '' });
  }
}

const lags = [];
for (const [k, v] of answeredAt) {
  const o = originOf.get(k);
  if (o) lags.push((Date.parse(v.ts) - Date.parse(o.ts)) / 60000);
}
lags.sort((a, b) => a - b);
if (lags.length < 20) { console.error('too few matched pairs to measure'); process.exit(1); }
const q = f => lags[Math.floor(lags.length * f)];
const worst = lags[lags.length - 1];
const newest = Date.parse(rows[rows.length - 1].ts);

console.log(`window   seq ${rows[0].seq}..${rows[rows.length - 1].seq}  ${rows[0].ts} .. ${rows[rows.length - 1].ts}`);
console.log(`records  ${rows.length}   registrations ${regs.length}   matched receipts ${lags.length}`);
console.log(`lag      median ${q(.5).toFixed(1)}m  p90 ${q(.9).toFixed(1)}m  p99 ${q(.99).toFixed(1)}m  max ${worst.toFixed(0)}m\n`);

const answered = r => answeredAt.has(`${r.did}|${r.rid}`);
// Only records older than the worst lag actually observed are settled. Anything newer is
// merely recent, and counting it as dropped would be the same overreach in reverse.
const settled = regs.filter(r => (newest - Date.parse(r.ts)) / 60000 > worst);
const silent = settled.filter(r => !answered(r));
console.log(`settled registrations (older than the worst observed lag): ${settled.length}`);
console.log(`  with no receipt of any kind: ${silent.length}  (${(silent.length / settled.length * 100).toFixed(1)}%)`);

const dids = new Set(settled.map(r => r.did));
const silentDids = [...dids].filter(d => !settled.some(r => r.did === d && answered(r)));
console.log(`distinct DIDs: ${dids.size}   never answered for any attempt: ${silentDids.length} (${(silentDids.length / dids.size * 100).toFixed(1)}%)\n`);

// Sticky or random? If the drop were independent per record, a DID that retries often
// would almost certainly be answered at least once. That is the difference between
// "retry and it may land" and "retrying cannot help you", which is what participants
// actually need to know.
const p = settled.filter(answered).length / settled.length;
const per = {};
for (const r of settled) (per[r.did] ??= []).push(r);
const many = Object.values(per).filter(a => a.length >= 8);
const manySilent = many.filter(a => !a.some(answered)).length;
console.log(`per-record receipt rate p = ${(p * 100).toFixed(1)}%`);
console.log(`DIDs with >= 8 attempts: ${many.length}   never answered once: ${manySilent}`);
console.log(`  expected if independent: ${(many.length * Math.pow(1 - p, 8)).toFixed(1)}`);
console.log(manySilent > many.length * 0.5 && many.length >= 10
  ? '  -> sticky per DID: retrying does not change the outcome'
  : '  -> consistent with an independent per-record drop');

const vocab = {};
for (const v of answeredAt.values()) {
  const k = `${v.status} :: ${v.reason || '(empty)'}`;
  vocab[k] = (vocab[k] ?? 0) + 1;
}
console.log('\nreferee verdict vocabulary:');
for (const [k, n] of Object.entries(vocab).sort((a, b) => b[1] - a[1]))
  console.log(`${String(n).padStart(6)}  ${k}`);
