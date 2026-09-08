#!/usr/bin/env node
// Drive a whole census against a service this test controls, and check what it says about
// runs that are not clean.
//
// This is the tool that produces every number this repository publishes, and its most
// important property is not accuracy on a good day — it is that an incomplete run cannot
// be mistaken for a complete one. The service 503s under load; a census that quietly drops
// four shards and prints the total anyway is how a repository ends up publishing a
// population figure that is 2% low and does not know it.
//
// Writes go to a temp directory via TC_OUT, so the real data/ and CENSUS.md are never
// touched. Reads go to a local server via TC_BASE. No network.
//
// Run: node tools/test-census.mjs
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const HEX = '0123456789abcdef';
const SHARDS = [...HEX].flatMap(a => [...HEX].map(b => a + b));

// Per shard: how many notes it holds. Shards named in `broken` answer 503 forever.
let perShard = () => 3;
let broken = new Set();
let legacyCount = 5;

const listing = n => Array.from({ length: n }, (_, i) => `/kv/x/${i}`).join('\n') + '\n';
const room = (name, size) => `/r/${name}          seq 1234      ${size}  0s ago`;
const messages = n => JSON.stringify({
  room: 'lobby', count: n, generation: 0,
  messages: Array.from({ length: n }, (_, i) => ({
    seq: i + 1,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    from: 'did:key:z6MkTest', text: 'x'.repeat(40), nonce: String(1788000000000 + i),
    sig: 'A'.repeat(85) + 'Q',
  })),
});

const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  const send = (body, type = 'text/plain') => {
    res.writeHead(200, { 'content-type': type }); res.end(body);
  };
  if (url === '/.well-known/agent.json') {
    return send(JSON.stringify({ version: '9.9.9', limits: {
      notes_per_namespace: 1000, rooms: 100, notes: 10000,
    } }), 'application/json');
  }
  if (url === '/rooms') {
    return send(['# 2 of 42 rooms (cap 100, 1.0M of 5.0G stored), newest first',
                 '# notes 500 of 10000 (1.0M total, 1000 per namespace)',
                 room('lobby', '1.0M'), room('technocore', '1.0M')].join('\n') + '\n');
  }
  if (url.startsWith('/r/')) return send(messages(60), 'application/json');
  if (url === '/kv/did') return send(listing(legacyCount));
  const m = /^\/kv\/did-([0-9a-f]{2})$/.exec(url);
  if (m) {
    if (broken.has(m[1])) { res.writeHead(503); return res.end('busy\n'); }
    return send(listing(perShard(m[1])));
  }
  res.writeHead(404); res.end('not found\n');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const run = async () => {
  const out = mkdtempSync(join(tmpdir(), 'tc-census-'));
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ['tools/census.mjs'], {
      cwd: ROOT, encoding: 'utf8',
      env: { ...process.env, TC_BASE: BASE, TC_OUT: out, TC_HTTP_TIMEOUT_MS: '3000',
             TC_SHARD_ATTEMPTS: '2', TC_SHARD_BASE: '5' },
    });
    const snap = JSON.parse(readFileSync(join(out, 'data', 'census-latest.json'), 'utf8'));
    const md = readFileSync(join(out, 'CENSUS.md'), 'utf8');
    const tsv = readFileSync(join(out, 'data', 'census-history.tsv'), 'utf8');
    return { ok: true, snap, md, tsv, stdout, stderr };
  } catch (e) {
    return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? String(e) };
  } finally { rmSync(out, { recursive: true, force: true }); }
};

let fails = 0;
const check = (name, ok, detail) => {
  if (!ok) fails++;
  console.log(`${ok ? 'OK  ' : '★FAIL'} ${name}${detail ? '\n        ' + detail : ''}`);
};

// --- a clean run --------------------------------------------------------------------
{
  broken = new Set();
  perShard = () => 3;
  const r = await run();
  check('깨끗한 실행: 256샤드 × 3 = 768 을 정확히 센다',
        r.ok && r.snap.sharded_total === 768,
        r.ok ? `sharded_total ${r.snap.sharded_total}, shards_read ${r.snap.shards_read}` : r.stderr.slice(-200));
  check('깨끗한 실행: complete = true, 읽기 실패 0',
        r.ok && r.snap.complete === true && r.snap.shards_unreadable === 0,
        r.ok ? `complete ${r.snap.complete}, unreadable ${r.snap.shards_unreadable}` : '');
  // 256 shards is even, so the median is a choice. Say which one it is rather than
  // leaving it to be discovered.
  check('샤드가 모두 3이면 중앙값도 3', r.ok && r.snap.shard_median === 3,
        r.ok ? `median ${r.snap.shard_median}` : '');
}

// --- shards that will not answer -----------------------------------------------------
{
  broken = new Set(['00', '01', '02', '03']);          // 4 of 256, under the 10% guard
  perShard = () => 3;
  const r = await run();
  const expected = (256 - 4) * 3;
  check('읽지 못한 샤드는 합계에서 빠진다 (총계는 하한이 된다)',
        r.ok && r.snap.sharded_total === expected,
        r.ok ? `sharded_total ${r.snap.sharded_total} (기대 ${expected})` : r.stderr.slice(-200));
  check('읽지 못한 샤드 수를 기록한다',
        r.ok && r.snap.shards_unreadable === 4 && r.snap.complete === false,
        r.ok ? `unreadable ${r.snap.shards_unreadable}, complete ${r.snap.complete}` : '');
  // The number being a floor has to be visible to a reader of the page, not only to a
  // reader of the JSON.
  check('CENSUS.md 가 불완전한 실행임을 본문에 밝힌다',
        r.ok && /incomplete|불완전|floor/i.test(r.md),
        r.ok ? (r.md.match(/^.*(incomplete|floor).*$/mi)?.[0] ?? '(그런 문장 없음)').slice(0, 100) : '');
  check('불완전한 실행도 이력에 기록되며 unreadable 열이 4 다',
        r.ok && (r.tsv.trim().split('\n').at(-1).split('\t')[10] === '4'),
        r.ok ? `열 11(shards_unreadable) = ${r.tsv.trim().split('\n').at(-1).split('\t')[10]}` : '');
}

// --- too many to be worth recording --------------------------------------------------
{
  broken = new Set(SHARDS.slice(0, 30));               // 30 of 256 = 11.7%, over the guard
  const r = await run();
  check('10% 를 넘게 못 읽으면 기록하지 않고 실패한다',
        !r.ok && /too incomplete/i.test(r.stderr),
        r.ok ? '★ 기록해버림' : (r.stderr.match(/Error:.*/)?.[0] ?? '').slice(0, 90));
}

// --- shard counts must land on the right shard ---------------------------------------
{
  broken = new Set();
  // Give every shard a different count derived from its name, so a misordered result
  // shows up as a mismatch rather than as a plausible total.
  perShard = shard => (parseInt(shard, 16) % 7) + 1;
  const r = await run();
  const expected = SHARDS.reduce((a, s) => a + ((parseInt(s, 16) % 7) + 1), 0);
  check('샤드별 개수가 뒤섞이지 않는다 (mapLimit 순서 보존)',
        r.ok && r.snap.sharded_total === expected &&
        r.snap.per_shard?.['ff'] === (parseInt('ff', 16) % 7) + 1,
        r.ok ? `합계 ${r.snap.sharded_total} (기대 ${expected}), per_shard.ff ${r.snap.per_shard?.['ff']}` : '');
}

// --- the legacy namespace at its cap --------------------------------------------------
{
  broken = new Set();
  perShard = () => 1;
  legacyCount = 1000;                                   // exactly notes_per_namespace
  const r = await run();
  check('레거시가 상한과 같으면 at_cap 으로 기록된다',
        r.ok && r.snap.legacy_at_cap === true && r.snap.legacy_headroom === 0,
        r.ok ? `legacy ${r.snap.legacy_total}, at_cap ${r.snap.legacy_at_cap}, headroom ${r.snap.legacy_headroom}` : '');
  legacyCount = 5;
}

server.close();
console.log(fails ? `\n★ ${fails}건 실패` : '\n전부 통과');
process.exit(fails ? 1 : 0);
