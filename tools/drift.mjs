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
import { get } from './http.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DATA = join(ROOT, 'data');
const FILE = join(DATA, 'protocol-fingerprints.json');
const BASE = process.env.TC_BASE || 'https://technocore.chat';

// Two groups, because they answer different questions.
//
// protocol — technocore.chat's own documents. A change here can make this
// client wrong: /interop.md and /config arrived in v0.10.0, the same release
// that changed the sweep rules and moved three caps.
//
// project — flop.finance. This is where the testnet and faucet get announced,
// where the tokenomics live, and where the hardware floors are published. The
// protocol watcher would never have seen any of it: it reads a different host
// entirely. Watching only technocore.chat means being ready for a change to the
// chat service and blind to the event actually being waited on.
const WATCHED = [
  { url: 'https://technocore.chat/llms.txt',              group: 'protocol' },
  { url: 'https://technocore.chat/auth.md',               group: 'protocol' },
  { url: 'https://technocore.chat/patterns.md',           group: 'protocol' },
  { url: 'https://technocore.chat/skill.md',              group: 'protocol' },
  { url: 'https://technocore.chat/interop.md',            group: 'protocol' },
  { url: 'https://technocore.chat/config',                group: 'protocol' },
  { url: 'https://technocore.chat/.well-known/agent.json', group: 'protocol' },
  { url: 'https://flop.finance/',                         group: 'project'  },
  { url: 'https://flop.finance/teaser/',                  group: 'project'  },
  { url: 'https://flop.finance/brand/',                   group: 'project'  },
  { url: 'https://flop.finance/design.md',                group: 'project'  },
];

const sha = s => createHash('sha256').update(s, 'utf8').digest('hex');
const lineHash = s => sha(s).slice(0, 12);

// Cloudflare injects a <style> block of @font-face rules into the flop.finance
// pages and emits them in a different order on every request — identical bytes,
// shuffled lines. Fingerprinted raw, all three HTML pages would report a change
// every single day and the watcher would cry wolf until it was ignored. Drop the
// injected lines; nothing being watched for lives in a font CDN block.
//
// Match the injection, not the subject. Cloudflare's additions are always inside a tag
// — a <style> block of @font-face rules, or a <script> touching __cf* — so requiring the
// line to open with one keeps authored prose in the fingerprint. Without that, this
// filter was dropping a line flop.finance wrote itself:
//
//   /cf-fonts/, so the delivered page never contacts fonts.googleapis.com — but
//
// a sentence of the page's own comment explaining the very same mechanism. The watcher
// could never have reported a change to it, and would have said nothing while looking
// straight at one.
const injected = l => /^\s*</.test(l) && (l.includes('/cf-fonts/') || l.includes('__cf'));
const normalize = text => text
  .split('\n')
  .filter(l => !injected(l))
  .join('\n');

async function fingerprint(url) {
  // http.mjs hands a 404 back as a response rather than throwing, so a document that
  // has been taken down used to be fingerprinted as whatever the error page said and
  // reported as "CHANGED: +3/-412 lines". A page that is gone is a different event from
  // a page that moved, and the one this watcher most needs to say plainly.
  const res = await get(url, { label: url });
  if (res.status === 404) return { gone: true, sha256: null, bytes: 0, lines: 0, line_hashes: [] };
  const text = normalize(await res.text());
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

for (const { url, group } of WATCHED) {
  const label = url.replace(/^https:\/\//, '');
  const fp    = await fingerprint(url);
  const prev  = previous.files?.[url];
  current.files[url] = fp;

  if (fp.gone) {
    if (prev?.gone) { console.log(`  gone     [${group}] ${label}  (still 404)`); continue; }
    console.log(`  GONE     [${group}] ${label}: HTTP 404 — the document was taken down`);
    changes.push({ url, label, group, gone: true, added: 0, removed: prev?.lines ?? 0,
                   before: prev?.sha256?.slice(0, 12) ?? '—', after: '404',
                   bytes_before: prev?.bytes ?? 0, bytes_after: 0 });
    continue;
  }
  if (!prev || prev.gone) {
    console.log(`  NEW      [${group}] ${label}  (${fp.lines} lines, ${fp.bytes} bytes) — ${prev ? 'back after a 404' : 'baseline recorded'}`);
    if (prev) changes.push({ url, label, group, added: fp.lines, removed: 0, before: '404',
                             after: fp.sha256.slice(0, 12), bytes_before: 0, bytes_after: fp.bytes });
    continue;
  }
  if (prev.sha256 === fp.sha256) {
    console.log(`  same     [${group}] ${label}`);
    continue;
  }
  const { added, removed } = drift(prev.line_hashes, fp.line_hashes);
  console.log(`  CHANGED  [${group}] ${label}: +${added}/-${removed} lines, ${prev.bytes} -> ${fp.bytes} bytes`);
  changes.push({ url, label, group, added, removed,
                 before: prev.sha256.slice(0, 12), after: fp.sha256.slice(0, 12),
                 bytes_before: prev.bytes, bytes_after: fp.bytes });
}

mkdirSync(DATA, { recursive: true });
writeFileSync(FILE, JSON.stringify(current, null, 1) + '\n');

// The workflow reads these to decide whether to open an issue.
if (process.env.GITHUB_OUTPUT) {
  const project = changes.filter(c => c.group === 'project');
  const row = c => c.gone
    ? `| [\`${c.label}\`](${c.url}) | **GONE — HTTP 404** | ${c.bytes_before} → 0 | \`${c.before}\` → 404 |`
    : `| [\`${c.label}\`](${c.url}) | +${c.added} / -${c.removed} | ${c.bytes_before} → ${c.bytes_after} | \`${c.before}\` → \`${c.after}\` |`;
  const table = list => ['| document | lines | bytes | sha256 |', '|---|---|---|---|', ...list.map(row)];

  const body = changes.length ? [
    ...(project.length ? [
      '## flop.finance moved',
      '',
      'This is the group worth reading first. The testnet, the faucet and the',
      'tokenomics are published here, and this is the announcement being waited on.',
      '',
      ...table(project), '',
    ] : []),
    ...(changes.length > project.length ? [
      '## technocore.chat protocol documents moved',
      '',
      'A change here can make this client wrong — the sweep rules and three caps',
      'have already moved once.',
      '',
      ...table(changes.filter(c => c.group === 'protocol')), '',
    ] : []),
    'Tracked by fingerprint, so the counts are exact but the text is not stored',
    'here — read the live document to see what moved. Then check whether',
    '`tc.mjs` and `GUIDE.ko.md` still match it.',
  ].join('\n') : '';

  writeFileSync(process.env.GITHUB_OUTPUT,
    `changed=${changes.length > 0}\n` +
    `project_changed=${project.length > 0}\n` +
    `summary<<DRIFT_EOF\n${body}\nDRIFT_EOF\n` +
    `ran=true\n`, { flag: 'a' });   // reached only if every document was fetched
}

console.log(changes.length ? `\n${changes.length} document(s) changed.` : '\nNo drift.');
