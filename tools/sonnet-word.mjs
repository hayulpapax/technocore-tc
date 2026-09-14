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
const ME   = process.env.SONNET_DID ||
  'did:key:z6Mkm8zag9f3tort6KkG44RuJy1wRgEnhkvn4K1m1kHvNPmf';
const GAME = process.env.SONNET_GAME || 'hotdogai';
const ROOM = process.env.SONNET_POEM_ROOM || `d-sonnet-2-team-${GAME}`;

const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1];
const J = t => { try { return JSON.parse(String(t).trim()); } catch { return null; } };

async function body(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.text();
}

// The generation is not in any receipt; the package says to read it from the room and
// retain it. Copying a stale generation into a proposal is what stranded team-asad.
const meta = JSON.parse(await body(`${BASE}/r/${ROOM}?format=json&since=0`));
const generation = meta.generation;

const rows = (await body(`${BASE}/r/${ROOM}/export`)).trim();
const recs = rows ? rows.split('\n').map(J).filter(Boolean) : [];

// Latest referee receipt carries the state to build on.
let state = null, accepted = [];
for (const r of recs) {
  if (r.from !== REF) continue;
  const j = J(r.text);
  if (!j || j.type !== 'sonnet.receipt.v1') continue;
  if (j.state_hash) state = j;
  if (/acc/i.test(j.status ?? '') && j.word) accepted.push({ word: j.word, who: j.sender_did });
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
