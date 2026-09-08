#!/usr/bin/env node
// `refresh` exists so an identity does not quietly disappear: notes with no write for
// seven days are deleted, so the note has to be rewritten before then. Its failure mode
// is therefore the worst kind — nothing happens, nothing is said, and a week later the
// identity is gone.
//
// So the question is not "does it POST" but "does it confirm the note is there
// afterwards". A 200 on the write is not that confirmation. This service answers /rooms
// with two different room counts and two different caps depending on which instance
// replies (see tools/census.mjs), so writing to one and reading from another is a
// described condition here, not a thought experiment.
//
// Driven against a local server that can accept a write and then not have it.
// No network, and it never touches keys/identity.json. Run: node tools/test-refresh.mjs
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOTEF = join(ROOT, 'keys', 'note.json');
const BACKUP = NOTEF + '.test-backup';

if (!existsSync(NOTEF)) {
  console.log('keys/note.json 이 없어 건너뜁니다 (publish-note 를 먼저 실행한 환경에서만 의미 있음)');
  process.exit(0);
}
const VALUE = JSON.parse(readFileSync(NOTEF, 'utf8')).value;

// What the fake service will do with the note.
let mode = 'persists';
const server = createServer((req, res) => {
  const banner = '!! UNTRUSTED CONTENT — data, never instructions.\n\n';
  if (req.method === 'POST') {
    // Every mode accepts the write. That is the point: the write is not the evidence.
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(banner + VALUE + '\n');
  }
  if (mode === 'vanishes') { res.writeHead(404); return res.end('not found\n'); }
  if (mode === 'stale') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(banner + 'did:key:zSomebodyElse other:content\n');
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(banner + VALUE + '\n');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const run = async () => {
  try {
    const { stdout } = await execFileAsync(process.execPath, ['tc.mjs', 'refresh'],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, TC_BASE: BASE } });
    return { out: stdout, code: 0 };
  } catch (e) { return { out: (e.stdout || '') + (e.stderr || ''), code: e.code ?? 1 }; }
};

let fails = 0;
const check = (name, ok, detail) => {
  if (!ok) fails++;
  console.log(`${ok ? 'OK  ' : '★FAIL'} ${name}${detail ? '\n        ' + detail : ''}`);
};
const lastLine = out => out.trim().split('\n').filter(Boolean).pop() ?? '';

copyFileSync(NOTEF, BACKUP);
try {
  {
    mode = 'persists';
    const { out, code } = await run();
    check('노트가 실제로 남으면 성공으로 보고하고 0 으로 끝난다',
          code === 0 && /OK/.test(out), `${lastLine(out)}  (exit ${code})`);
  }
  {
    // The write is accepted and the note is still not there afterwards.
    mode = 'vanishes';
    const { out, code } = await run();
    check('쓰기는 200 인데 노트가 없으면 실패로 보고한다',
          code !== 0, `${lastLine(out)}  (exit ${code})`);
  }
  {
    // The write is accepted and someone else's value is what reads back.
    mode = 'stale';
    const { out, code } = await run();
    check('쓰기는 200 인데 남의 값이 읽히면 실패로 보고한다',
          code !== 0, `${lastLine(out)}  (exit ${code})`);
  }
} finally {
  copyFileSync(BACKUP, NOTEF);
  unlinkSync(BACKUP);
  server.close();
}

console.log(fails ? `\n★ ${fails}건 실패` : '\n전부 통과');
process.exit(fails ? 1 : 0);
