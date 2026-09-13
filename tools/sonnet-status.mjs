#!/usr/bin/env node
// Where this account stands in the sonnet contest, written for the daily briefing.
//
// A background watcher tells the session that started it; it does not reach the person.
// The one channel that does is the daily briefing the routine reads out, so the contest
// has to report itself there — registration receipt, the referee's backlog, what is
// submitted, and how the vote stands as the deadline approaches.
//
// Reads only. It never registers, votes or submits: those are decisions, and they are
// made by a person and sent with tc.mjs.
//
// Writes data/sonnet-status.json for tools/briefing.mjs to render.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from './http.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT  = process.env.TC_OUT || join(HERE, '..');
const BASE = process.env.TC_BASE || 'https://technocore.chat';

// The contest, the referee and our own identity. The referee DID is the one pinned in
// LAUNCH.md and verified against /kv/room-owners — not inferred from who posts.
const CONTEST  = process.env.SONNET_CONTEST || 'sonnet-2';
const REFEREE  = process.env.SONNET_REFEREE ||
  'did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte';
const ME       = process.env.SONNET_DID ||
  'did:key:z6Mkm8zag9f3tort6KkG44RuJy1wRgEnhkvn4K1m1kHvNPmf';
const DEADLINE = process.env.SONNET_DEADLINE || '2026-09-18T12:00:00Z';

// The seq our registration was written at, recorded when it was sent. The registration
// room is a ring that turns over in hours: ours went in at 21,611 and the window had
// moved past 77,000 within a day. Once the message ages out of every read this constant
// is the only handle left on it, and without it this tool reports "not posted" for a
// record the referee has already handled.
// 95,184 is the re-post: the rules' own recovery for a lost receipt is an identical
// retry under the same request_id, which "returns its original receipt without appending
// or changing vote order". The first attempt, seq 21,611, was handled and its receipt
// expired unseen.
const SENT_SEQ = Number(process.env.SONNET_SENT_SEQ) || 95184;

const REG   = `mb-${CONTEST}-registration`;
const SUB   = `mb-${CONTEST}-submissions`;
const VOTES = `mb-${CONTEST}-votes`;
const RULES = `d-${CONTEST}-rules`;

async function exportRoom(name) {
  const res = await get(`${BASE}/r/${name}/export`, { label: name, attempts: 4 });
  if (res.status !== 200) return [];
  const text = await res.text();
  if (!text.trim()) return [];
  return text.trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } })
             .filter(Boolean);
}
const json = t => { try { return JSON.parse(String(t).trim()); } catch { return null; } };

// The referee batches. A receipt started out as one verdict with `sender_did` and
// `request_id` at the top level, and by the second day it was
//   {"status":…,"reason":…,"receipts":[{"request_id":…,"sender_did":…}, …]}
// with one status covering the whole batch. Reading only the old shape reported
// "registration not posted" for a record already handled — worse than reporting nothing.
// Flatten both shapes into one list of verdicts.
function verdicts(rec) {
  const j = json(rec.text);
  if (!j) return [];
  const base = { status: j.status ?? null, reason: j.reason ?? null,
                 ts: rec.ts, seq: rec.seq, intake_seq: j.intake_seq ?? null };
  if (Array.isArray(j.receipts)) {
    return j.receipts.map(r => ({ ...base,
      sender_did: r.sender_did ?? null, request_id: r.request_id ?? null,
      entry_id: r.entry_id ?? j.entry_id ?? null }));
  }
  if (j.sender_did) {
    return [{ ...base, sender_did: j.sender_did, request_id: j.request_id ?? null,
              entry_id: j.entry_id ?? null }];
  }
  return [];
}

// Ownership is what makes the referee the referee. If it ever stops matching the pinned
// DID, everything below is worthless and the briefing must say so rather than report a
// tidy status — this is the failure that killed sonnet-1.
async function refereeOwns(name) {
  const res = await get(`${BASE}/kv/room-owners/${name}`, { label: `owner ${name}`, attempts: 3 });
  if (res.status !== 200) return false;
  const body = (await res.text()).split('\n')
    .filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('!!')).join(' ');
  return body.includes(REFEREE);
}

const out = {
  contest: CONTEST,
  checked_at: new Date().toISOString(),
  deadline: DEADLINE,
  hours_left: Math.round((Date.parse(DEADLINE) - Date.now()) / 3600000),
  referee: REFEREE,
  referee_owns_rules: await refereeOwns(RULES),
};

/* ---- our registration ------------------------------------------------------------- */
const reg = await exportRoom(REG);
const mine = reg.filter(r => r.from === ME);
const regVerdicts = reg.filter(r => r.from === REFEREE).flatMap(verdicts);
const ours = regVerdicts.filter(v => v.sender_did === ME);

// The registry lives with the referee, not in the room. So "absent from the window" is
// not "not registered", and the two have to be reported differently or a silent eviction
// reads as a silent rejection.
const oldest = reg.length ? reg[0].seq : null;
// `intake_seq` is the referee's own counter across all 32 rooms it reads, not a seq in
// this room — measured 2026-09-13: intake stood at 96,455 while this room's newest
// record was 96,104. Comparing it with a room seq is a category error, and doing so
// reported "the referee has passed our registration" for something still in the queue.
// Keep it for context and never treat it as a position in this room.
const intakeSeqs = regVerdicts.map(v => v.intake_seq).filter(n => typeof n === 'number');
const intakeNow = intakeSeqs.length ? Math.max(...intakeSeqs) : null;

out.registration = {
  posted: mine.length ? { seq: mine[0].seq, ts: mine[0].ts } : null,
  receipt: ours.length
    ? { status: ours[ours.length - 1].status, reason: ours[ours.length - 1].reason,
        ts: ours[ours.length - 1].ts }
    : null,
  sent_seq: SENT_SEQ,
  window: { oldest_seq: oldest, oldest_ts: reg.length ? reg[0].ts : null },
  evicted: oldest !== null && SENT_SEQ < oldest,
  referee_intake_counter: intakeNow,
};

// Where the referee actually is, on this room's own seq axis.
//
// intake_seq cannot answer this: it is the referee's counter across all the rooms it
// reads, and it ran ahead of this room's newest seq. Comparing the two produced a
// confident "the referee has passed us" for a registration whose status was unknown.
//
// Each receipt names (sender_did, request_id), and the record it answers is in this room
// with its own seq. Matching them back puts the referee's position on the same axis as
// our registration, and the post-to-receipt lag says when silence has become an answer.
const originOf = new Map();
for (const r of reg) {
  if (r.from === REFEREE) continue;
  const j = json(r.text);
  if (j?.type !== 'sonnet.register.v1' || !j.request_id) continue;
  const k = r.from + '|' + j.request_id;
  if (!originOf.has(k)) originOf.set(k, r);
}
const answeredAt = new Map();
for (const v of regVerdicts) {
  if (!v.sender_did || !v.request_id) continue;
  const k = v.sender_did + '|' + v.request_id;
  if (!answeredAt.has(k)) answeredAt.set(k, v);
}
const pairs = [];
for (const [k, v] of answeredAt) {
  const o = originOf.get(k);
  if (o) pairs.push({ seq: o.seq, lag_min: (Date.parse(v.ts) - Date.parse(o.ts)) / 60000 });
}
if (pairs.length > 20) {
  const lags = pairs.map(x => x.lag_min).sort((a, b) => a - b);
  const frontier = Math.max(...pairs.map(x => x.seq));
  const worst = lags[lags.length - 1];
  out.registration.frontier = {
    highest_answered_seq: frontier,
    matched_pairs: pairs.length,
    lag_median_min: Number(lags[Math.floor(lags.length * 0.5)].toFixed(1)),
    lag_p99_min: Number(lags[Math.floor(lags.length * 0.99)].toFixed(1)),
    lag_max_min: Number(worst.toFixed(0)),
  };
  // A record is only "unanswered" once it is older than the worst lag actually seen.
  // Below that it is merely recent, and calling it dropped would repeat the old mistake
  // in the other direction.
  const settledIf = ts => (Date.now() - Date.parse(ts)) / 60000 > worst;
  const settled = reg.filter(r => {
    if (r.from === REFEREE) return false;
    const j = json(r.text);
    return j?.type === 'sonnet.register.v1' && j.request_id && settledIf(r.ts);
  });
  const unanswered = settled.filter(r => {
    const j = json(r.text);
    return !answeredAt.has(r.from + '|' + j.request_id);
  });
  out.registration.silent_rate = {
    settled_records: settled.length,
    without_receipt: unanswered.length,
    pct: settled.length ? Number((unanswered.length / settled.length * 100).toFixed(1)) : null,
    note: 'validly signed registrations older than the worst observed lag with no receipt of any kind',
  };
  // Our own state, in the only three words that are honest here.
  const ourRecs = mine.filter(r => json(r.text)?.type === 'sonnet.register.v1');
  out.registration.ours = ourRecs.map(r => {
    const j = json(r.text);
    const v = answeredAt.get(r.from + '|' + j.request_id);
    return { seq: r.seq, role: j.role ?? null, request_id: j.request_id ?? null,
             age_min: Math.round((Date.now() - Date.parse(r.ts)) / 60000),
             state: v ? (v.status ?? 'answered') : settledIf(r.ts) ? 'silent' : 'too recent to call',
             reason: v?.reason ?? null };
  });
}

// Acceptance mix over the surviving window — how selective the identity gate is, not a
// count of the whole contest.
const tally = {};
for (const v of regVerdicts) tally[v.status ?? '?'] = (tally[v.status ?? '?'] ?? 0) + 1;
out.registration.referee_totals = tally;

/* ---- entries ----------------------------------------------------------------------- */
const sub = await exportRoom(SUB);
const subVerdicts = sub.filter(r => r.from === REFEREE).flatMap(verdicts);
const acceptedEntries = new Set();
for (const v of subVerdicts) if (/acc/i.test(v.status ?? '') && v.entry_id) acceptedEntries.add(v.entry_id);
out.entries = {
  submissions_seen: sub.filter(r => r.from !== REFEREE && /sonnet\.submit\.v1/.test(String(r.text))).length,
  referee_accepted: subVerdicts.filter(v => /acc/i.test(v.status ?? '')).length,
  referee_rejected: subVerdicts.filter(v => !/acc/i.test(v.status ?? '')).length,
  accepted_ids: [...acceptedEntries].slice(0, 40),
};

/* ---- the vote ---------------------------------------------------------------------- */
// Only ballots the referee accepted count, and only the last one from each voter.
const votes = await exportRoom(VOTES);
const accepted = new Map();
for (const r of votes) {
  if (r.from !== REFEREE) continue;
  for (const v of verdicts(r)) {
    if (!/acc/i.test(v.status ?? '') || !v.sender_did || !v.entry_id) continue;
    accepted.set(v.sender_did, v.entry_id);
  }
}
const counts = {};
for (const e of accepted.values()) counts[e] = (counts[e] ?? 0) + 1;
out.vote = {
  accepted_ballots: accepted.size,
  we_have_voted: accepted.has(ME),
  our_choice: accepted.get(ME) ?? null,
  standings: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8)
             .map(([entry_id, votes]) => ({ entry_id, votes })),
};

mkdirSync(join(OUT, 'data'), { recursive: true });
writeFileSync(join(OUT, 'data', 'sonnet-status.json'), JSON.stringify(out, null, 1) + '\n');

const r = out.registration;
const ourState = (r.ours ?? []).map(o => `${o.role} ${o.state}`).join(', ');
const regWord = r.receipt ? r.receipt.status
  : ourState
    ? ourState + (r.silent_rate ? ` — ${r.silent_rate.pct}% of settled registrations get no receipt` : '')
  : r.evicted ? 'sent, but our record has aged out of the window — receipt unseen'
  : r.posted ? 'posted, unanswered'
  : 'not in the window';
console.log(`sonnet ${CONTEST}: ${out.hours_left}h left · registration ${regWord} · ` +
  `${out.entries.referee_accepted} entries accepted · ${out.vote.accepted_ballots} ballots`);
