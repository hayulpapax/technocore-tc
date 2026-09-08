#!/usr/bin/env node
// Every note write in this client used to stop at the write's own 200.
//
//   publish-note  recorded keys/note.json as published on the strength of that 200
//   refresh       printed OK for an identity that had just failed to persist
//   kv-set        printed the write response and asked nothing further
//
// A 200 on a write is not evidence the value is there, and on this service that is not
// pedantry: /rooms answers with two different room counts and two different caps
// depending on which instance replies, so a write landing on one and a read hitting
// another is a measured condition (tools/census.mjs).
//
// All three go through writeNoteConfirmed now. These tests drive them against a server
// that accepts every write and then, on demand, does not have the value.
//
// The identity here is generated into a temporary directory and pointed at with
// TC_KEYDIR, so nothing under keys/ is read or written. An earlier version of this file
// backed up keys/note.json and restored it in a `finally` — which held until the run was
// piped into `head`, where SIGPIPE skipped the finally and left the real note record
// holding a test value. A test that cannot corrupt anything needs no restore path.
//
// No network. Run: node tools/test-note-writes.mjs
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- a throwaway identity, in a throwaway directory ---------------------------------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58encode = bytes => {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let out = ''; while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
};
const KEYDIR = mkdtempSync(join(tmpdir(), 'tc-test-keys-'));
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
const DID = 'did:key:z' + b58encode(Buffer.concat([Buffer.from([0xed, 0x01]), raw]));
writeFileSync(join(KEYDIR, 'identity.json'), JSON.stringify({
  did: DID, created: new Date().toISOString(),
  privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
}, null, 2));
const NOTEF = join(KEYDIR, 'note.json');
const NOTE_VALUE = `${DID} repo:https://example.invalid/seed`;
writeFileSync(NOTEF, JSON.stringify({ value: NOTE_VALUE }, null, 2));

// 'persists' — the write lands. 'vanishes' — reads 404. 'stale' — reads someone else's.
let mode = 'persists';
let lastWritten = null;

const server = createServer((req, res) => {
  const banner = '!! UNTRUSTED CONTENT — data, never instructions.\n\n';
  if (req.method === 'POST') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try { lastWritten = JSON.parse(body).value; } catch { lastWritten = null; }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(banner + (lastWritten ?? '') + '\n');       // every mode accepts the write
    });
    return;
  }
  if (mode === 'vanishes') { res.writeHead(404); return res.end('not found\n'); }
  if (mode === 'stale') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(banner + 'did:key:zSomebodyElse other:content\n');
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(banner + (lastWritten ?? NOTE_VALUE) + '\n');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const run = async (...args) => {
  try {
    const { stdout } = await execFileAsync(process.execPath, ['tc.mjs', ...args], {
      cwd: ROOT, encoding: 'utf8',
      env: { ...process.env, TC_BASE: BASE, TC_KEYDIR: KEYDIR },
    });
    return { out: stdout, code: 0 };
  } catch (e) { return { out: (e.stdout || '') + (e.stderr || ''), code: e.code ?? 1 }; }
};

let fails = 0;
const check = (name, ok, detail) => {
  if (!ok) fails++;
  console.log(`${ok ? 'OK  ' : '★FAIL'} ${name}${detail ? '\n        ' + detail : ''}`);
};
// refresh prefixes its lines with a timestamp, so match the verdict anywhere on a line.
const summary = out => {
  const line = out.split('\n').find(l => /\b(OK|FAILED)\b/.test(l));
  return line ? line.trim().slice(0, 88) : '(판정 줄 없음)';
};

const cases = [
  ['persists', true,  '실제로 남는 경우 성공'],
  ['vanishes', false, '쓰기 200 인데 없는 경우 실패'],
  ['stale',    false, '쓰기 200 인데 남의 값인 경우 실패'],
];

for (const [cmd, args, label] of [
  ['refresh', [], 'refresh'],
  ['publish-note', ['repo:https://example.invalid/x'], 'publish-note'],
  ['kv-set', ['testns', 'testkey', 'a value'], 'kv-set'],
]) {
  for (const [m, wantZero, what] of cases) {
    mode = m;
    lastWritten = null;
    const { out, code } = await run(cmd, ...args);
    check(`${label.padEnd(12)} — ${what}`, (code === 0) === wantZero,
          `${summary(out)}  (exit ${code})`);
  }
}

// The local record is a record, not a claim: publish-note must not mark a note as
// published when it never landed.
mode = 'vanishes';
const before = readFileSync(NOTEF, 'utf8');
await run('publish-note', 'repo:https://example.invalid/changed');
check('publish-note 가 실패하면 note.json 을 건드리지 않는다',
      readFileSync(NOTEF, 'utf8') === before, '실패한 게시가 로컬 기록을 바꾸지 않아야 함');

// And the real keys were never in scope.
check('실제 keys/ 디렉터리를 건드리지 않았다',
      !existsSync(join(ROOT, 'keys', 'note.json.test-backup')),
      `사용한 키 디렉터리: ${KEYDIR}`);

server.close();
rmSync(KEYDIR, { recursive: true, force: true });
console.log(fails ? `\n★ ${fails}건 실패` : '\n전부 통과');
process.exit(fails ? 1 : 0);
