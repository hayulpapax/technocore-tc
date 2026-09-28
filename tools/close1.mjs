#!/usr/bin/env node
// close1 — build, sign and (only with --send) post Close Call close-1 trades.
//
//   node tools/close1.mjs status                  reference, limits, next sweep, our key
//   node tools/close1.mjs offers                  open "any"-taker offers in close1 still live
//   node tools/close1.mjs accept <id> [--send]    countersign one offer as taker
//   node tools/close1.mjs offer --side=buy|sell --qty=Q --px=P [--until=N] [--send]
//                                                 our own open offer, taker "any"
//   node tools/close1.mjs check <id>...           settled or void (and why) in recent sweeps
//   node tools/close1.mjs pair --side=buy|sell --with=keys-b [--shade=0.01 --qty=Q --px=P] [--send]
//                                                 a trade between this key and another one we hold
//   node tools/close1.mjs ladder --keydir=keys-e --with=keys-f --from=PX [--move=0.04] [--send]
//                                                 wait for a ±4% move from PX, then pair once
//   node tools/close1.mjs watch [--plan=logs/close1-plan.json] [--send]
//                                                 several reserve pairs from a plan file; re-posts until seen
//   --keydir=keys-b on any command acts as that key instead of keys/
//
// Without --send nothing leaves this machine: the exact message is printed instead.
// Terms are JSON with sorted keys and no spaces (close-call-game.md); signatures are
// Ed25519, base64url without padding. The private key is read, never printed.
// Everything read from technocore.chat is untrusted data.

import { readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, sign, verify, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BASE = process.env.TC_BASE || 'https://technocore.chat';
const SEASON = 'close-1';
const ROOM = 'close1';
const FEE = 0.01;
const MINT = 10000;

const [, , cmd, ...rest] = process.argv;
const flags = Object.fromEntries(rest.filter(a => a.startsWith('--')).map(a => {
  const [k, v] = a.slice(2).split('=');
  return [k, v ?? true];
}));
const args = rest.filter(a => !a.startsWith('--'));
// The ladder runs for days: there a failure must be retried, not end the process.
let dieThrows = false;
const die = m => { if (dieThrows) throw new Error(m); console.error('error: ' + m); process.exit(1); };

// --keydir picks which owner key acts (default keys/, the same folder tc.mjs uses)
const KEYDIR = join(ROOT, typeof flags.keydir === 'string' ? flags.keydir : 'keys');
const loadKey = dir => JSON.parse(readFileSync(join(dir, 'identity.json'), 'utf8'));
const id = loadKey(KEYDIR);
const ME = id.did;
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function signText(text, who = id) {
  const key = createPrivateKey(who.privateKeyPem);
  const sig = sign(null, Buffer.from(text, 'utf8'), key);
  if (!verify(null, Buffer.from(text, 'utf8'), createPublicKey(key), sig)) die('local signature check failed');
  const s = b64u(sig);
  if (s.length !== 86) die('signature is not 86 chars');
  return s;
}
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(str) {
  let n = 0n;
  for (const c of str) { const i = B58.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of str) { if (c !== '1') break; out.unshift(0); }
  return Buffer.from(out);
}
function verifyDid(did, text, sig) {
  try {
    const b = b58decode(did.replace(/^did:key:z/, ''));
    if (b[0] !== 0xed || b[1] !== 0x01 || b.length !== 34) return false;
    const pub = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), b.subarray(2)]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(text, 'utf8'), pub, Buffer.from(sig, 'base64url'));
  } catch { return false; }
}
// sorted keys, no spaces — the only form the referee accepts as terms
const canon = o => '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + JSON.stringify(o[k])).join(',') + '}';
const dec = (v, name) => {
  const s = String(v);
  if (!/^\d+(\.\d{1,2})?$/.test(s)) die(name + ' must be a decimal with at most two places: ' + s);
  return Number(s).toFixed(2);
};

async function get(path) {
  for (let i = 1; i <= 4; i++) {
    try {
      const r = await fetch(BASE + path, { signal: AbortSignal.timeout(90_000) });
      if (r.ok) return r.json();
    } catch {}
    await new Promise(r => setTimeout(r, 3000));
  }
  die('could not read ' + path);
}
const J = s => { try { return JSON.parse(s); } catch { return null; } };
async function latest(room) {
  const j = await get(`/r/${room}?format=json&limit=1`);
  return J(j.messages?.at(-1)?.text ?? '');
}
async function price() {
  const p = await latest('d-close1-price');
  if (!p || p.t !== 'price') die('no price post');
  return p;
}
function post(text, { rooms, keyDir = KEYDIR } = {}) {
  if (!flags.send) {
    console.log('\n(dry run — nothing sent; add --send to post)\n' + text);
    return;
  }
  // --room=a,b posts to each. The same id settles at most once, so posting one trade in two
  // rooms is harmless. But a registered room only counts while listed, and since sweep 206
  // the referee unlists rooms about an hour after listing them (issue #11: boz-desk went at
  // 228, qxlab-desk at 370), so close1 is the one room that reliably counts.
  rooms ??= typeof flags.room === 'string' ? flags.room.split(',') : [ROOM];
  for (const room of rooms) {
    const out = execFileSync(process.execPath, [join(ROOT, 'tc.mjs'), 'say', room, text],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, TC_KEYDIR: keyDir } });
    // tc.mjs echoes the room's tail after a say; keep only our own line
    const mine = out.split(/\r?\n/).filter(l => l.includes(text.slice(0, 60)));
    console.log(`[${room}] ` + (mine.length ? 'posted: ' + mine.join('\n').slice(0, 160) + '…' : out.trim().split(/\r?\n/).slice(-4).join('\n')));
  }
}
function cost(side, qty, px) {           // what opening this many contracts ties up, plus the 1% fee
  return Number(qty) * Number(px) * (1 + FEE);
}

async function status() {
  const p = await price();
  console.log(`sweep n=${p.n} · next sweep n=${p.n + 1}`);
  console.log(`reference ${p.ref.px} (HL trade ${p.ref.time}) · age ${p.age_s}s`);
  console.log(`limits for the next sweep ${p.limits[0]} – ${p.limits[1]} · global ${p.global}`);
  console.log(`our key ${ME}`);
  const mine = (await scan()).find(m => m.from === ME && J(m.text)?.t === 'owner');
  console.log(mine ? `registered in ${ROOM} at seq ${mine.seq} (${mine.ts}) — minted at the first sweep after it` : `NOT registered in ${ROOM} (or it has left the room)`);
  console.log(`one-sided max at the reference ≈ ${(MINT / (Number(p.ref.px) * (1 + FEE))).toFixed(2)} contracts`);
}

// The whole room, from its stored file. ?since= returns only the newest 200 whatever it is
// given, and close1 is mostly owner registrations, so paging the read path misses offers.
async function scan() {
  for (let i = 1; i <= 4; i++) {
    try {
      const r = await fetch(`${BASE}/r/${ROOM}/export`, { signal: AbortSignal.timeout(120_000) });
      if (r.ok) return (await r.text()).split(/\r?\n/).map(J).filter(Boolean);
    } catch {}
    await new Promise(r => setTimeout(r, 3000));
  }
  die('could not export ' + ROOM);
}
async function openOffers() {
  const p = await price();
  const next = p.n + 1;
  const [lo, hi] = p.limits.map(Number);
  const msgs = await scan();
  const traded = new Set();
  const offers = new Map();
  for (const m of msgs) {
    const t = J(m.text);
    if (!t?.terms) continue;
    if (t.t === 'trade') { traded.add(t.terms.id); continue; }
    if (!t.maker_sig || t.terms.taker !== 'any') continue;
    const x = t.terms;
    if (x.maker !== m.from) continue;                       // an offer posted by someone other than its maker
    if (!(x.until >= next)) continue;
    const px = Number(x.px);
    if (!(px >= lo && px <= hi)) continue;
    offers.set(x.id, { terms: x, maker_sig: t.maker_sig, seq: m.seq, ts: m.ts });
  }
  for (const k of traded) offers.delete(k);
  return { p, offers: [...offers.values()].filter(o => o.terms.maker !== ME) };
}

async function offersCmd() {
  const { p, offers } = await openOffers();
  console.log(`reference ${p.ref.px} · limits ${p.limits.join('–')} · next sweep ${p.n + 1}`);
  if (!offers.length) return console.log('no live open offers found in the scanned pages');
  for (const o of offers.sort((a, b) => Number(a.terms.px) - Number(b.terms.px))) {
    const x = o.terms;
    const ours = x.side === 'buy' ? 'we SELL (short)' : 'we BUY (long)';
    console.log(`${x.id}  maker ${x.side} ${x.qty} @ ${x.px} → ${ours} · until ${x.until} · ${x.maker.slice(8, 20)}… · seq ${o.seq}`);
  }
}

async function acceptCmd() {
  const want = args[0] || die('accept <id>');
  const { p, offers } = await openOffers();
  const o = offers.find(o => o.terms.id === want) || die('no live open offer with id ' + want);
  const x = o.terms;
  const terms = canon(x);
  // the maker's signature must verify, or the referee voids it and we learn nothing
  if (!verifyDid(x.maker, `${SEASON}|terms|${terms}`, o.maker_sig)) die('the maker signature does not verify — the referee would void this');
  const need = cost(x.side === 'buy' ? 'sell' : 'buy', x.qty, x.px);
  if (need > MINT) die(`this needs ≈ ${need.toFixed(2)} POLF, more than a fresh mint`);
  const taker_sig = signText(`${SEASON}|accept|${terms}|${ME}`);
  const msg = JSON.stringify({ t: 'trade', season: SEASON, terms: JSON.parse(terms), taker: ME, maker_sig: o.maker_sig, taker_sig });
  console.log(`accept ${x.id}: maker ${x.side}s ${x.qty} @ ${x.px}; we take the other side`);
  console.log(`ties up ≈ ${need.toFixed(2)} POLF incl. the 1% fee · reference ${p.ref.px} · settles at sweep ${p.n + 1} if still valid`);
  post(msg);
}

async function offerCmd() {
  const side = flags.side;
  if (side !== 'buy' && side !== 'sell') die('--side=buy|sell');
  const qty = dec(flags.qty ?? die('--qty'), 'qty');
  const px = dec(flags.px ?? die('--px'), 'px');
  if (Number(qty) < 0.1) die('qty must be at least 0.1');
  const p = await price();
  const [lo, hi] = p.limits.map(Number);
  if (Number(px) < lo || Number(px) > hi) die(`px outside the next sweep's limits ${p.limits.join('–')}`);
  const until = flags.until ? Number(flags.until) : p.n + 12;       // an hour of sweeps by default
  const need = cost(side, qty, px);
  if (need > MINT) die(`this needs ≈ ${need.toFixed(2)} POLF, more than a fresh mint`);
  const terms = { id: randomBytes(4).toString('hex'), maker: ME, px, qty, side, taker: 'any', until };
  const maker_sig = signText(`${SEASON}|terms|${canon(terms)}`);
  const msg = JSON.stringify({ t: 'offer', season: SEASON, terms: JSON.parse(canon(terms)), maker_sig });
  console.log(`offer ${terms.id}: we ${side} ${qty} @ ${px}, anyone may take it until sweep ${until}`);
  console.log(`ties up ≈ ${need.toFixed(2)} POLF incl. the 1% fee · reference ${p.ref.px}`);
  post(msg);
}

async function checkCmd() {
  if (!args.length) die('check <id>...');
  const j = await get(`/r/d-close1-flow?format=json&limit=50`);
  for (const want of args) {
    let found = null;
    for (const m of j.messages) {
      const t = J(m.text);
      if (!t) continue;
      if ((t.settled || []).includes(want)) found = `settled at sweep ${t.n} (${m.ts})`;
      const v = (t.void || []).find(v => v[0] === want);
      if (v) found = `void at sweep ${t.n}: ${v[1]} (${m.ts})`;
    }
    console.log(`${want}: ${found ?? 'not in the recent flow posts (pending, or the list was truncated)'}`);
  }
}

// A trade between two keys one operator holds (rule 8 allows many keys). This key is the
// maker on --side and gets a price --shade better than the reference (default 1%): a side
// that beats the sweep's closing price pays that gap instead of the 1% fee, so up to 1% the
// better price costs nothing extra. Quantity is the largest both sides can still fund if
// the settling sweep closes up to 1% away from the reference either way.
// Sweeps are numbered by the clock (n=1 at 12:05Z, every 5 min), but the referee has run
// 20+ minutes behind, so the last posted n understates where a new message lands.
const clockSweep = () => Math.floor((Date.now() - Date.parse('2026-09-25T12:05:00Z')) / 300_000) + 1;

// Build and sign a trade between two keys we hold. Returns the message; posts nothing.
function buildPair({ maker, taker, side, p, shade = 0.01, px: pxIn, qty: qtyIn, until: untilIn }) {
  if (side !== 'buy' && side !== 'sell') die('side must be buy or sell');
  if (maker.did === taker.did) die('maker and taker are the same key');
  const ref = Number(p.ref.px);
  const raw = side === 'buy' ? ref * (1 - shade) : ref * (1 + shade);
  // round toward the reference so the gap never exceeds the shade
  const pxN = side === 'buy' ? Math.ceil(raw * 100) / 100 : Math.floor(raw * 100) / 100;
  const px = pxIn ? dec(pxIn, 'px') : pxN.toFixed(2);
  const [lo, hi] = p.limits.map(Number);
  if (Number(px) < lo || Number(px) > hi) die(`px outside the next sweep's limits ${p.limits.join('–')}`);
  const P = Number(px);
  const need = gap => P + Math.max(FEE * P, gap);           // POLF per contract, fee or clawback
  const buyer = need(Math.max(0, ref * 1.01 - P));          // worst case: the close is 1% up
  const seller = need(Math.max(0, P - ref * 0.99));         // worst case: the close is 1% down
  const qMax = Math.floor(MINT / Math.max(buyer, seller) * 100) / 100;
  const qty = qtyIn ? dec(qtyIn, 'qty') : qMax.toFixed(2);
  const until = untilIn ? Number(untilIn) : Math.min(2556, Math.max(p.n, clockSweep()) + 7);
  const terms = { id: 'p' + randomBytes(4).toString('hex'), maker: maker.did, px, qty, side, taker: taker.did, until };
  const t = canon(terms);
  const maker_sig = signText(`${SEASON}|terms|${t}`, maker);
  const taker_sig = signText(`${SEASON}|accept|${t}|${taker.did}`, taker);
  const msg = JSON.stringify({ t: 'trade', season: SEASON, terms: JSON.parse(t), taker: taker.did, maker_sig, taker_sig });
  return { terms, msg };
}

async function pairCmd(side = flags.side) {
  if (typeof flags.with !== 'string') die('--with=<keydir of the other key>');
  const other = loadKey(join(ROOT, flags.with));
  const p = await price();
  const { terms, msg } = buildPair({
    maker: id, taker: other, side, p,
    shade: flags.shade !== undefined ? Number(flags.shade) : 0.01,
    px: typeof flags.px === 'string' ? flags.px : undefined,
    qty: typeof flags.qty === 'string' ? flags.qty : undefined,
    until: flags.until,
  });
  console.log(`pair ${terms.id}: ${ME.slice(8, 20)}… ${side}s ${terms.qty} @ ${terms.px} · ${other.did.slice(8, 20)}… takes the other side`);
  console.log(`reference ${p.ref.px} (sweep ${p.n}) · valid through sweep ${terms.until} · funds hold if the close stays within ±1%`);
  post(msg);
}

// The standing plan: several reserve pairs, each fired once when the reference first moves
// its distance from the base, shaded toward the move reverting (a short after a rise, a long
// after a fall) — the earlier pairs already cover the move continuing. A fired trade is
// posted in close1 again every sweep until it shows up settled or void, or its `until`
// passes: close1 is flooded and the referee has skipped whole ranges of it (sweep 24 missed
// 280099–335672), and an id settles at most once, so re-posting is harmless.
// The plan lives in a JSON file (default logs/close1-plan.json) so a restart resumes it.
async function watchCmd() {
  const file = join(ROOT, typeof flags.plan === 'string' ? flags.plan : 'logs/close1-plan.json');
  const plan = JSON.parse(readFileSync(file, 'utf8'));
  plan.fired ??= {};
  const save = () => writeFileSync(file, JSON.stringify(plan, null, 2));
  const stamp = () => new Date().toISOString().slice(0, 19) + 'Z';
  const lockAt = Date.parse('2026-10-04T08:50:00Z');
  dieThrows = true;
  let lastN = null;
  for (;;) {
    if (Date.now() >= lockAt) { console.log(`${stamp()} the lock is near; stopping`); return; }
    try {
      const p = await price();
      const ref = Number(p.ref.px);
      const r = ref / plan.base - 1;
      const now = clockSweep();
      // 1. fire any level the move has reached
      for (const lv of plan.levels) {
        if (plan.fired[lv.name]) continue;
        const hit = lv.dir === 'up' ? r >= lv.move : lv.dir === 'down' ? r <= -lv.move : Math.abs(r) >= lv.move;
        if (!hit) continue;
        const side = r > 0 ? 'sell' : 'buy';
        if (!flags.send) { console.log(`(check only) ${lv.name} would fire now: ${lv.maker} ${side}s`); continue; }
        const maker = loadKey(join(ROOT, lv.maker)), taker = loadKey(join(ROOT, lv.taker));
        const { terms, msg } = buildPair({ maker, taker, side, p, until: Math.min(2556, now + 6) });
        plan.fired[lv.name] = { id: terms.id, side, px: terms.px, qty: terms.qty, until: terms.until,
          ref: p.ref.px, at: stamp(), maker: lv.maker, msg, posts: 0, lastPostN: 0, outcome: null };
        save();
        console.log(`${stamp()} sweep ${p.n}: ${lv.name} fired — ref ${p.ref.px} is ${(r * 100).toFixed(2)}% from ${plan.base}; ${lv.maker} ${side}s ${terms.qty} @ ${terms.px} (${terms.id})`);
      }
      // 2. learn outcomes from the latest flow post, then re-post whatever is still open
      const flow = await latest('d-close1-flow');
      for (const [name, f] of Object.entries(flags.send ? plan.fired : {})) {
        if (f.outcome) continue;
        if ((flow?.settled || []).includes(f.id)) f.outcome = `settled at sweep ${flow.n}`;
        const v = (flow?.void || []).find(x => x[0] === f.id);
        if (v) f.outcome = v[1] === 'settled' ? `settled earlier (void as repeat at ${flow.n})` : `void at sweep ${flow.n}: ${v[1]}`;
        if (!f.outcome && now > f.until) f.outcome = `until ${f.until} passed — not seen in the (truncated) flow lists`;
        if (!f.outcome && now > f.lastPostN) {
          post(f.msg, { rooms: [ROOM], keyDir: join(ROOT, f.maker) });
          f.posts++; f.lastPostN = now;
        }
        if (f.outcome) console.log(`${stamp()} ${name} ${f.id}: ${f.outcome} after ${f.posts} post(s)`);
        save();
      }
      if (p.n !== lastN) {                                  // one line per sweep, not per poll
        const open = plan.levels.filter(l => !plan.fired[l.name]).map(l => `${l.name}(${l.dir === 'down' ? '−' : l.dir === 'up' ? '+' : '±'}${(l.move * 100).toFixed(0)}%)`);
        console.log(`${stamp()} sweep ${p.n}: reference ${p.ref.px} (age ${p.age_s}s), ${(r * 100).toFixed(2)}% from ${plan.base} · waiting: ${open.join(' ') || 'none'}`);
        lastN = p.n;
      }
      if (!flags.send) return console.log('(check only — with --send it keeps watching)');
    } catch (e) {
      console.log(`${stamp()} ${e.message} — retrying`);
    }
    await new Promise(r => setTimeout(r, 60_000));
  }
}

// The reserve pair: wait until the reference has moved --move (default 4%) from --from,
// then open a pair whose shaded side bets on the move reverting (a short after a rise, a
// long after a fall). The first pairs already cover the move continuing; this one covers
// the path coming back, from a better entry than theirs. Fires once and exits.
async function ladderCmd() {
  const from = Number(flags.from);
  if (!(from > 0)) die('--from=<the reference our first pairs entered at>');
  const move = flags.move !== undefined ? Number(flags.move) : 0.04;
  const stamp = () => new Date().toISOString().slice(0, 19) + 'Z';
  const lockAt = Date.parse('2026-10-04T08:50:00Z');
  dieThrows = !!flags.send;
  let lastN = null;
  for (;;) {
    if (Date.now() >= lockAt) { console.log(`${stamp()} the lock is near; stopped without firing`); return; }
    try {
      const p = await price();
      const r = Number(p.ref.px) / from - 1;
      if (Math.abs(r) >= move) {
        const side = r > 0 ? 'sell' : 'buy';
        console.log(`${stamp()} sweep ${p.n}: reference ${p.ref.px} is ${(r * 100).toFixed(2)}% from ${from} — this key ${side}s`);
        await pairCmd(side);
        console.log(`${stamp()} fired once; exiting`);
        return;
      }
      if (p.n !== lastN) {                                  // one line per sweep, not per poll
        console.log(`${stamp()} sweep ${p.n}: reference ${p.ref.px} (age ${p.age_s}s), ${(r * 100).toFixed(2)}% from ${from} (trigger ±${(move * 100).toFixed(1)}%)`);
        lastN = p.n;
      }
      if (!flags.send) return console.log('(check only — with --send it keeps watching and fires once)');
    } catch (e) {
      console.log(`${stamp()} ${e.message} — retrying`);
    }
    await new Promise(r => setTimeout(r, 60_000));
  }
}

const cmds = { status, offers: offersCmd, accept: acceptCmd, offer: offerCmd, check: checkCmd, pair: pairCmd, ladder: ladderCmd, watch: watchCmd };
if (!cmds[cmd]) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 21).join('\n')); process.exit(cmd ? 1 : 0); }
await cmds[cmd]();
