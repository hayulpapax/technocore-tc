#!/usr/bin/env node
// `verify` is a diagnosis. Its job is not to say "rejected" — the server already does
// that — but to say WHY, so the caller fixes the right thing. A diagnosis that names the
// wrong cause is worse than none: it sends someone to regenerate a key that was fine.
//
// That is not hypothetical. The DID parse and the signature decode once shared a catch
// that blamed the DID, so a signature in a non-canonical base64url spelling — correct
// bytes, correct key — was reported as "DID parses as Ed25519 did:key: FAIL".
//
// So: inject exactly one fault at a time and assert which line goes FAIL, which goes
// "----" (not checked, which is not the same as failed), and that nothing else moves.
//
// No network. Run: node tools/test-verify.mjs
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58encode = bytes => {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let out = ''; while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
};
const b64url = buf => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
const DID = 'did:key:z' + b58encode(Buffer.concat([Buffer.from([0xed, 0x01]), raw]));
const sign = p => b64url(edSign(null, Buffer.from(p, 'utf8'), privateKey));

const ROOM = 'lobby', NONCE = '1788999000000', TEXT = 'hello world';
const GOOD = sign(`${ROOM}|${NONCE}|${TEXT}`);

// Sixteen spellings decode to the same 64 bytes; only the one whose padding bits are
// zero is accepted. Take one of the other fifteen.
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const lastVal = A.indexOf(GOOD.at(-1));
const NON_CANONICAL = GOOD.slice(0, -1) +
  A[[...Array(64).keys()].find(v => (v & 0b110000) === (lastVal & 0b110000) && v !== lastVal)];

const SIG_LINE = 'signature covers `<room>|<nonce>|<swept text>`';

const run = async (...args) => {
  try {
    const { stdout } = await execFileAsync(process.execPath, ['tc.mjs', 'verify', ...args],
      { cwd: ROOT, encoding: 'utf8' });
    return stdout;
  } catch (e) { return (e.stdout || '') + (e.stderr || ''); }
};
const lines = (out, prefix) => out.split('\n')
  .filter(l => l.startsWith(prefix)).map(l => l.slice(prefix.length).trim());

let fails = 0;
const check = (name, ok, detail) => {
  if (!ok) fails++;
  console.log(`${ok ? 'OK  ' : '★FAIL'} ${name}${detail ? '\n        ' + detail : ''}`);
};

const cases = [
  { name: '결함 없음', args: [ROOM, NONCE, TEXT, DID, GOOD], fail: [], skip: [] },

  { name: '방 이름이 문법 위반', args: ['Lobby!', NONCE, TEXT, DID, GOOD],
    fail: ['room name matches ^[a-z0-9][a-z0-9_-]{0,47}$', SIG_LINE], skip: [] },

  { name: 'nonce 가 숫자가 아님', args: [ROOM, 'abc', TEXT, DID, GOOD],
    fail: ['nonce is 1-19 digits', SIG_LINE], skip: [] },

  // The whole point: the key is fine, only the spelling is wrong. Nothing may accuse
  // the DID, and the coverage check must be skipped rather than reported as failed.
  { name: '서명이 비정규 표기 (바이트는 동일)', args: [ROOM, NONCE, TEXT, DID, NON_CANONICAL],
    fail: ['signature is canonical base64url'],
    skip: [SIG_LINE + '  — NOT CHECKED, fix the FAILs above'] },

  { name: '앞뒤 공백이 있는 원문에 서명함',
    args: [ROOM, NONCE, `  ${TEXT}  `, DID, sign(`${ROOM}|${NONCE}|  ${TEXT}  `)],
    fail: ['text survives the sweep unchanged', SIG_LINE], skip: [] },

  { name: 'NFD 텍스트',
    args: [ROOM, NONCE, '한글'.normalize('NFD'), DID, sign(`${ROOM}|${NONCE}|${'한글'.normalize('NFD')}`)],
    fail: ['text is unchanged by NFC normalization'], skip: [] },

  // A key that cannot be parsed cannot verify anything, so the coverage line is not a
  // failure — it is a question that was never asked.
  { name: 'DID 가 깨짐', args: [ROOM, NONCE, TEXT, 'did:key:zNOTAKEY', GOOD],
    fail: ['DID parses as Ed25519 did:key'],
    skip: [SIG_LINE + '  — NOT CHECKED, fix the FAILs above'] },

  { name: '다른 방에 서명함', args: [ROOM, NONCE, TEXT, DID, sign(`other|${NONCE}|${TEXT}`)],
    fail: [SIG_LINE], skip: [] },
];

for (const c of cases) {
  const out = await run(...c.args);
  const gotFail = lines(out, '  FAIL ');
  const gotSkip = lines(out, '  ---- ');
  const diff = (want, got, label) => {
    const missing = want.filter(w => !got.includes(w));
    const extra = got.filter(g => !want.includes(g));
    return [missing.length ? `${label} 못 잡음: ${missing.join(' / ')}` : '',
            extra.length ? `${label} 엉뚱하게: ${extra.join(' / ')}` : ''].filter(Boolean);
  };
  const problems = [...diff(c.fail, gotFail, 'FAIL'), ...diff(c.skip, gotSkip, 'SKIP')];
  check(c.name, problems.length === 0,
        problems.length ? problems.join('\n        ')
                        : `FAIL ${gotFail.length}건${gotSkip.length ? `, 미검사 ${gotSkip.length}건` : ''}`);
}

console.log(fails ? `\n★ ${fails}건 실패` : '\n전부 통과');
process.exit(fails ? 1 : 0);
