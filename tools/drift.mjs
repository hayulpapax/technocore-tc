#!/usr/bin/env node
// Watch the technocore.chat protocol documents for changes.
//
// The manual is the protocol here, and it says so: "prose here is the
// authority". When it moves, every client built against it can silently start
// being wrong — this repo included. Four requests a day is a cheap way to find
// out on the day it happens instead of from a bug report.
//
// It stores fingerprints, never the documents themselves: a SHA-256 of each
// file plus a per-line hash list. That is enough to say what changed and by how
// much without redistributing someone else's text.

import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DATA = join(ROOT, 'data');
const FILE = join(DATA, 'protocol-fingerprints.json');
const BASE = process.env.TC_BASE || 'https://technocore.chat';

const WATCHED = ['/llms.txt', '/auth.md', '/patterns.md', '/skill.md', '/.well-known/agent.json'];

const sha = s => createHash('sha256').update(s, 'utf8').digest('hex');
const lineHash = s => sha(s).slice(0, 12);

async function fingerprint(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.split('\n');
  return { sha256: sha(text), bytes: Buffer.byteLength(text, 'utf8'), lines: lines.length,
           line_hashes: lines.map(lineHash) };
}

// multiset difference — enough for "N added, M removed" without keeping the text
function drift(oldHashes = [], newHashes = []) {
  const bag = new Map();
  for (const h of oldHashes) bag.set(h, (bag.get(h) || 0) + 1);
  let added = 0;
  for (const h of newHashes) {
    const n = bag.get(h) || 0;
    if (n > 0) bag.set(h, n - 1); else added++;
  }
  let removed = 0;
  for (const n of bag.values()) removed += n;
  return { added, removed };
}

const previous = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { files: {} };
const current  = { checked_at: new Date().toISOString(), files: {} };
const changes  = [];

for (const path of WATCHED) {
  const fp   = await fingerprint(path);
  const prev = previous.files?.[path];
  current.files[path] = fp;

  if (!prev) {
    console.log(`  NEW      ${path}  (${fp.lines} lines, ${fp.bytes} bytes) — baseline recorded`);
    continue;
  }
  if (prev.sha256 === fp.sha256) {
    console.log(`  same     ${path}`);
    continue;
  }
  const { added, removed } = drift(prev.line_hashes, fp.line_hashes);
  const line = `${path}: +${added}/-${removed} lines, ${prev.bytes} -> ${fp.bytes} bytes`;
  console.log(`  CHANGED  ${line}`);
  changes.push({ path, added, removed, before: prev.sha256.slice(0, 12), after: fp.sha256.slice(0, 12),
                 bytes_before: prev.bytes, bytes_after: fp.bytes });
}

mkdirSync(DATA, { recursive: true });
writeFileSync(FILE, JSON.stringify(current, null, 1) + '\n');

// The workflow reads these to decide whether to open an issue.
if (process.env.GITHUB_OUTPUT) {
  const body = changes.length
    ? ['The technocore.chat protocol documents changed. This repository tracks them by',
       'fingerprint, so the counts below are exact but the text is not stored here —',
       'read the live document to see what moved.', '',
       '| document | lines | bytes | sha256 |',
       '|---|---|---|---|',
       ...changes.map(c => `| [\`${c.path}\`](${BASE}${c.path}) | +${c.added} / -${c.removed} | ${c.bytes_before} → ${c.bytes_after} | \`${c.before}\` → \`${c.after}\` |`),
       '', 'Check whether `tc.mjs` and `GUIDE.ko.md` still match the manual.'].join('\n')
    : '';
  writeFileSync(process.env.GITHUB_OUTPUT,
    `changed=${changes.length > 0}\n` +
    `summary<<DRIFT_EOF\n${body}\nDRIFT_EOF\n`, { flag: 'a' });
}

console.log(changes.length ? `\n${changes.length} document(s) changed.` : '\nNo drift.');
