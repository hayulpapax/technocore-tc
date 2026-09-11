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
import { get, getJson } from './http.mjs';

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

const room = n => `${n}-${CONTEST}`.replace(/^(mb|d)-/, '$1-');
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

// --- our registration, and the referee's backlog in front of it ----------------------
const reg = await exportRoom(REG);
const mine = reg.filter(r => r.from === ME);
const receipts = reg.filter(r => r.from === REFEREE).map(r => ({ r, j: json(r.text) }))
                    .filter(x => x.j);
const ours = receipts.filter(x => x.j.sender_did === ME);

out.registration = {
  posted: mine.length ? { seq: mine[0].seq, ts: mine[0].ts } : null,
  receipt: ours.length
    ? { status: ours[ours.length - 1].j.status, reason: ours[ours.length - 1].j.reason ?? null,
        ts: ours[ours.length - 1].r.ts }
    : null,
};

// Intake position and rate, measured over the most recent receipts rather than all of
// them: the opening burst was slower and drags a whole-run average down.
const withIntake = receipts.filter(x => typeof x.j.intake_seq === 'number');
if (withIntake.length > 10 && out.registration.posted && !out.registration.receipt) {
  const a = withIntake[Math.max(0, withIntake.length - 200)], b = withIntake[withIntake.length - 1];
  const mins = (Date.parse(b.r.ts) - Date.parse(a.r.ts)) / 60000;
  const rate = mins > 0 ? (b.j.intake_seq - a.j.intake_seq) / mins : 0;
  const behind = out.registration.posted.seq - b.j.intake_seq;
  out.registration.queue = {
    intake_seq: b.j.intake_seq,
    ahead_of_us: behind,
    seq_per_min: Number(rate.toFixed(1)),
    eta_hours: rate > 0 ? Number((behind / rate / 60).toFixed(1)) : null,
  };
}

// Acceptance mix, so the briefing can say how selective the identity gate is.
const tally = {};
for (const { j } of receipts) tally[j.status ?? '?'] = (tally[j.status ?? '?'] ?? 0) + 1;
out.registration.referee_totals = tally;

// --- entries -------------------------------------------------------------------------
const sub = await exportRoom(SUB);
const subReceipts = sub.filter(r => r.from === REFEREE).map(r => json(r.text)).filter(Boolean);
const acceptedEntries = new Set();
for (const j of subReceipts) {
  if (/acc/i.test(j.status ?? '') && (j.entry_id || j.game_id)) {
    acceptedEntries.add(j.entry_id || j.game_id);
  }
}
out.entries = {
  submissions_seen: sub.filter(r => r.from !== REFEREE && /sonnet\.submit\.v1/.test(String(r.text))).length,
  referee_accepted: subReceipts.filter(j => /acc/i.test(j.status ?? '')).length,
  referee_rejected: subReceipts.filter(j => !/acc/i.test(j.status ?? '')).length,
  accepted_ids: [...acceptedEntries].slice(0, 40),
};

// --- the vote ------------------------------------------------------------------------
// Only ballots the referee accepted count, and only the last one from each voter.
const votes = await exportRoom(VOTES);
const accepted = new Map();          // voter -> entry_id, last accepted wins
for (const r of votes) {
  if (r.from !== REFEREE) continue;
  const j = json(r.text);
  if (!j || !/acc/i.test(j.status ?? '') || !j.sender_did || !j.entry_id) continue;
  accepted.set(j.sender_did, j.entry_id);
}
const counts = {};
for (const e of accepted.values()) counts[e] = (counts[e] ?? 0) + 1;
out.vote = {
  accepted_ballots: accepted.size,
  we_have_voted: accepted.has(ME),
  our_choice: accepted.get(ME) ?? null,
  standings: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6)
             .map(([entry_id, votes]) => ({ entry_id, votes })),
};

mkdirSync(join(OUT, 'data'), { recursive: true });
writeFileSync(join(OUT, 'data', 'sonnet-status.json'), JSON.stringify(out, null, 1) + '\n');

const r = out.registration;
console.log(`sonnet ${CONTEST}: ${out.hours_left}h left · ` +
  `registration ${r.receipt ? r.receipt.status : r.queue ? `queued, ${r.queue.ahead_of_us} ahead (~${r.queue.eta_hours}h)` : 'not posted'} · ` +
  `${out.entries.referee_accepted} entries accepted · ${out.vote.accepted_ballots} ballots`);
