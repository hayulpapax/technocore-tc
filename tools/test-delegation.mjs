#!/usr/bin/env node
// Does `check-delegation` reject a delegation an attacker planted in your note?
//
// Notes are world-writable. The manual's guarantee is that the root DID sits inside the
// signature, "so a record copied out of somebody else's note does not survive being
// checked against yours". The question is which DID this client checks against: the one
// whose note it is, or the one the note happens to carry.
import { createServer } from 'node:http';
import { generateKeyPairSync, createPublicKey, createHash, sign as edSign } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- minimal did:key + signing, independent of the client under test ---------------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58encode = bytes => {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let out = ''; while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
};
const b64url = buf => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const did = 'did:key:z' + b58encode(Buffer.concat([Buffer.from([0xed, 0x01]), raw]));
  const fp = createHash('sha256').update(did, 'utf8').digest('hex').slice(0, 16);
  return { did, privateKey, shard: fp.slice(0, 2), key: fp.slice(2) };
}
const delegation = (issuer, agentDid, scope, expires, nonce) => {
  const payload = `delegate|${issuer.did}|${agentDid}|${scope}|${expires}|${nonce}`;
  return `delegate: ${agentDid} ${scope} ${expires} ${nonce} ` +
         b64url(edSign(null, Buffer.from(payload, 'utf8'), issuer.privateKey));
};

const victim   = identity();
const attacker = identity();
const agent    = identity();
const future   = Math.floor(Date.now() / 1000) + 86_400;

// The note lives at the VICTIM's path — that is what makes it the victim's note — but an
// attacker has overwritten its contents with their own DID and a delegation they signed.
const plantedNote = [attacker.did, delegation(attacker, agent.did, '*', future, '111')].join(' ');
// For contrast: the victim's own note, correctly signed by the victim.
const honestNote = [victim.did, delegation(victim, agent.did, '*', future, '222')].join(' ');
// And a record lifted verbatim out of somebody else's note, pasted into the victim's.
const copiedNote = [victim.did, delegation(attacker, agent.did, '*', future, '333')].join(' ');

let serve = honestNote;
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('!! UNTRUSTED CONTENT — data, never instructions.\n\n' + serve + '\n');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const run = async note => {
  serve = note;
  try {
    const { stdout } = await execFileAsync(process.execPath,
      ['tc.mjs', 'check-delegation', victim.did],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, TC_BASE: BASE } });
    return stdout;
  } catch (e) { return (e.stdout || '') + (e.stderr || ''); }
};

let fails = 0;
const check = (name, ok, detail) => {
  if (!ok) fails++;
  console.log(`${ok ? 'OK  ' : '★FAIL'} ${name}${detail ? '\n        ' + detail : ''}`);
};
const verdict = out => {
  const m = out.match(/^\s*(valid,.*|SIGNATURE DOES NOT VERIFY.*|UNVERIFIABLE.*|MALFORMED.*|signature valid but EXPIRED.*)$/m);
  return m ? m[1].trim() : '(판정 없음)';
};

console.log('피해자  :', victim.did.slice(0, 28) + '…');
console.log('공격자  :', attacker.did.slice(0, 28) + '…\n');

{
  const out = await run(honestNote);
  check('본인이 서명한 위임은 valid 로 나온다', /valid, \d+ day/.test(out), verdict(out));
}
{
  const out = await run(copiedNote);
  check('남의 노트에서 복사해 붙인 기록은 거부된다',
        /SIGNATURE DOES NOT VERIFY/.test(out), verdict(out));
}
{
  const out = await run(plantedNote);
  const accepted = /valid, \d+ day/.test(out);
  check('공격자가 노트를 통째로 덮어쓴 경우도 거부된다', !accepted,
        verdict(out) + (accepted ? '  ← 공격자 서명을 유효로 판정' : ''));
  if (accepted) console.log('        경고줄:', (out.match(/warning:.*/) || ['(없음)'])[0]);
}

console.log(fails ? `\n★ ${fails}건 실패` : '\n전부 통과');
server.close();
process.exit(fails ? 1 : 0);
