#!/usr/bin/env node
// close1-keys — make the extra close-1 owner keys and register them in close1.
//
//   node tools/close1-keys.mjs c d e f           create keys-c … keys-f if missing (local only)
//   node tools/close1-keys.mjs c d e f --send    …and post each one's owner registration
//
// Never touches keys/ (the main identity) and never overwrites an existing key: tc.mjs
// keygen refuses when identity.json exists, and this script does not pass --force.
// Each key is minted 10,000 POLF at the first sweep after its registration.

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const send = argv.includes('--send');
const names = argv.filter(a => !a.startsWith('--'));
if (!names.length || names.some(n => !/^[b-z]$/.test(n))) {
  console.error('usage: node tools/close1-keys.mjs c d e f [--send]   (single letters b–z; a is keys/)');
  process.exit(1);
}
const tc = (dir, ...args) => execFileSync(process.execPath, [join(ROOT, 'tc.mjs'), ...args],
  { cwd: ROOT, encoding: 'utf8', env: { ...process.env, TC_KEYDIR: dir } });

// who is already registered — the room's stored file, so a rerun does not register twice
let registered = new Set();
if (send) {
  const r = await fetch('https://technocore.chat/r/close1/export', { signal: AbortSignal.timeout(120_000) });
  if (!r.ok) { console.error('could not read close1; nothing sent'); process.exit(1); }
  for (const line of (await r.text()).split(/\r?\n/)) {
    try { const m = JSON.parse(line); if (JSON.parse(m.text).t === 'owner') registered.add(m.from); } catch {}
  }
}

for (const n of names) {
  const dir = join(ROOT, 'keys-' + n);
  const file = join(dir, 'identity.json');
  if (!existsSync(file)) tc(dir, 'keygen');
  const did = JSON.parse(readFileSync(file, 'utf8')).did;
  let state = 'key ready';
  if (send) {
    if (registered.has(did)) state = 'already registered';
    else {
      const text = JSON.stringify({ t: 'owner', season: 'close-1', key: did });
      const out = tc(dir, 'say', 'close1', text);
      state = out.includes(did.slice(-4) + '> ' + text) || out.includes(text) ? 'registered' : 'sent — check: ' + out.trim().split(/\r?\n/).pop();
    }
  }
  console.log(`keys-${n}  ${did}  ${state}`);
}
if (!send) console.log('\n(local only — add --send to register them in close1)');
