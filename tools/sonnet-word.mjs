#!/usr/bin/env node
// Read the team poem's current state, and optionally propose the next word.
//
//   node tools/sonnet-word.mjs                 show state and what we may legally play
//   node tools/sonnet-word.mjs --word=the      print the exact payload to sign (no send)
//
// The contest accepts the FIRST valid proposal for the current state, ordered by the
// referee's durable intake, so the state has to be read immediately before proposing:
// every proposal quotes room_generation, version and previous_state_hash, and a proposal
// against a superseded state is stale, not queued.
//
// Two rules decide whether a word is legal for THIS DID:
//   - every letter of the word must occur in the full exact registered DID including the
//     did:key: prefix, case-insensitively (apostrophes and trailing punctuation exempt);
//   - the syllable count comes from the frozen cmudict.dict, charging the largest listed
//     count, and a line is exactly 10 syllables - reaching 10 closes it, and an
//     overflowing word is rejected rather than carried to the next line.
//
// Reads only. It never sends: proposing is a turn in a live game and is done deliberately.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.TC_BASE || 'https://technocore.chat';
const REF  = process.env.SONNET_REFEREE ||
  'did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte';
// "나"는 이 폴더의 키에서 읽습니다. 예전에는 한 사람의 DID 가 박혀 있어서,
// 다른 팀원이 실행하면 남의 기준으로 인접 규칙을 판정했습니다. 실제로 한 명이
// 자기 차례인데 "직전 기여자라 불가"라는 안내를 받고 물러났습니다.
function whoAmI() {
  if (process.env.SONNET_DID) return process.env.SONNET_DID;
  for (const f of ['keys/identity.json', '../keys/identity.json']) {
    try { const d = JSON.parse(readFileSync(f, 'utf8')).did; if (d) return d; } catch {}
  }
  return null;
}
const ME = whoAmI();
if (!ME) {
  console.error('keys/identity.json 에서 내 DID 를 읽지 못했습니다.');
  console.error('tc.mjs 가 있는 폴더에서 실행하거나, SONNET_DID 를 지정하세요.');
  process.exit(1);
}
const GAME = process.env.SONNET_GAME || 'hayulpapax';
const ROOM = process.env.SONNET_POEM_ROOM || `d-sonnet-2-team-${GAME}`;

const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1];
const J = t => { try { return JSON.parse(String(t).trim()); } catch { return null; } };

// 서비스가 간헐적으로 503 을 냅니다. 오늘만 아홉 번 관측됐고 전부 1분 내외였습니다.
// 재시도 없이 던지면 팀원 화면에 스택 트레이스가 뜨고, 자기가 뭘 잘못한 줄 알고
// 물러서게 됩니다. 몇 번 다시 걸어보고, 그래도 안 되면 한 줄로 알려줍니다.
async function body(url, tries = 5) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (r.ok) return r.text();
      if (i < tries) console.log(`  서버가 ${r.status} 로 응답했습니다. 다시 시도합니다 (${i}/${tries})...`);
    } catch {
      if (i < tries) console.log(`  서버 응답이 없어 다시 시도합니다 (${i}/${tries})...`);
    }
    if (i < tries) await new Promise(r => setTimeout(r, 5000));
  }
  console.error('');
  console.error('서버에 연결하지 못했습니다. 잠시 뒤 다시 실행해 주세요.');
  console.error('(당신 잘못이 아닙니다. 서비스가 가끔 몇 분간 응답하지 않습니다.)');
  process.exit(1);
}

// The generation is not in any receipt; the package says to read it from the room and
// retain it. Copying a stale generation into a proposal is what stranded team-asad.
const meta = JSON.parse(await body(`${BASE}/r/${ROOM}?format=json&since=0`));
const generation = meta.generation;

const rows = (await body(`${BASE}/r/${ROOM}/export`)).trim();
const recs = rows ? rows.split('\n').map(J).filter(Boolean) : [];

// A word receipt does NOT echo the word. Observed in d-sonnet-2-team-mitsuri-beacon-2,
// an accepted proposal comes back as only
//   {status, version, state_hash, syllables, complete, request_id, sender_did}
// so reading j.word finds nothing and the poem silently looks empty. The word lives in
// the proposer's own sonnet.word.v1 record, and the receipt points at it by
// (sender_did, request_id) — the same join we already rely on in discovery.
const PROPOSED = new Map();
for (const r of recs) {
  if (r.from === REF) continue;
  const j = J(r.text);
  if (j?.type !== 'sonnet.word.v1' || !j.request_id) continue;
  // Only the FIRST proposal under a request_id counts. Re-sending that id with a
  // different word returns the original receipt and changes nothing, so taking the
  // last one shows a word that is not in the poem. Observed live: purple sent "wake"
  // and then "remember" under ord-24; "wake" is what the referee accepted.
  const k = r.from + '|' + j.request_id;
  if (!PROPOSED.has(k)) PROPOSED.set(k, j.word);
}

// Latest referee receipt carries the state to build on.
let state = null, accepted = [];
for (const r of recs) {
  if (r.from !== REF) continue;
  const j = J(r.text);
  if (!j || j.type !== 'sonnet.receipt.v1') continue;
  if (j.state_hash) state = j;
  if (!/acc/i.test(j.status ?? '')) continue;
  const w = j.word ?? PROPOSED.get(j.sender_did + '|' + j.request_id);
  if (w) accepted.push({ word: w, who: j.sender_did, syllables: j.syllables ?? null });
}

console.log(`room        ${ROOM}`);
console.log(`generation  ${generation}`);
console.log(`records     ${recs.length}   accepted words ${accepted.length}`);
if (state) {
  console.log(`version     ${state.version ?? '(none)'}`);
  console.log(`state_hash  ${state.state_hash}`);
}
if (accepted.length) {
  console.log(`\npoem so far:\n  ${accepted.map(a => a.word).join(' ')}`);
  // Whether the receipt's "syllables" counts the word or the open line is not yet
  // decidable: the only sample so far is a one-syllable word at version 1, where both
  // readings give 1. Print the raw figure rather than a total we cannot justify, and
  // settle it on our own first accepted word.
  const syl = accepted.map(a => a.syllables).filter(x => x !== null);
  if (syl.length) console.log('  referee syllables, per receipt: ' + syl.join(' '));
  const tally = new Map();
  for (const a of accepted) tally.set(a.who, (tally.get(a.who) ?? 0) + 1);
  console.log('  words per member:');
  for (const [who, n] of tally) console.log('    ' + (who === ME ? 'us ' : '   ') + who.slice(9, 21) + '  ' + n);
  const last = accepted[accepted.length - 1];
  if (last.who === ME) {
    console.log('\n  NOTE: we supplied the last accepted word. The rules bar the previous');
    console.log('        accepted contributor from proposing the next one — wait for someone else.');
  }
}
if (!accepted.some(a => a.who === ME)) {
  console.log('\n  WE HAVE NOT CONTRIBUTED A WORD YET. Every frozen roster member must supply at');
  console.log('  least one accepted word or the poem does not qualify.');
}

const word = arg('word');
if (!word) {
  const vp = join(HERE, '..', 'data', 'sonnet-vocab.json');
  if (existsSync(vp)) {
    const v = JSON.parse(readFileSync(vp, 'utf8'));
    console.log('\nour legal vocabulary by syllable count:');
    for (const n of Object.keys(v).sort((a, b) => a - b))
      console.log(`  ${n}: ${v[n].length}`);
  }
  console.log('\nrun again with --word=<word> to build the payload.');
  process.exit(0);
}

// Check the word against this DID before building anything.
const have = new Set(ME.toLowerCase().split('').filter(c => c >= 'a' && c <= 'z'));
const core = word.toLowerCase().replace(/[,.;:!?]$/, '').replace(/'/g, '');
const bad = [...new Set([...core])].filter(c => !have.has(c));
if (!/^[A-Za-z']+[,.;:!?]?$/.test(word)) {
  console.error(`\nREJECTED locally: "${word}" is not one English word plus optional trailing ,.;:!?`);
  process.exit(2);
}
if (bad.length) {
  console.error(`\nREJECTED locally: "${word}" uses ${bad.join(' ')}, absent from this DID.`);
  process.exit(2);
}
if (!state) {
  console.error('\nNo referee state_hash yet — the poem has not started; nothing to build on.');
  process.exit(3);
}

const payload = {
  type: 'sonnet.word.v1',
  contest_id: 'sonnet-2',
  game_id: GAME,
  room_generation: generation,
  version: state.version ?? 0,
  previous_state_hash: state.state_hash,
  word,
  request_id: `hayulpapax-word-${Date.now()}`,
};
console.log(`\n"${word}" is legal for this DID. Payload:\n`);
console.log(JSON.stringify(payload));
console.log(`\nsend with:\n  node tc.mjs say ${ROOM} '${JSON.stringify(payload)}'`);
