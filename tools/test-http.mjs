#!/usr/bin/env node
// Property tests for http.mjs, against a local server that can produce any response on
// demand. Every tool here goes through that file, so a wrong retry decision in it is a
// wrong decision everywhere at once — and two of its behaviours could only be observed
// by asking a server to misbehave on purpose:
//
//   * fetch has no default timeout, so a socket that opens and never answers hung the
//     call forever. On a runner that is six hours for a two-minute census.
//   * get() returns a 404 rather than throwing, which left getJson parsing a plain-text
//     body and reporting "SyntaxError: Unexpected token 'o'" — an error about the wrong
//     thing entirely.
//
// No network. Run: node tools/test-http.mjs
import { createServer } from 'node:http';
import { get, getText, getJson } from './http.mjs';

let plan = [];      // queue of responses for the next requests
let seen = [];      // what the server actually received

const server = createServer((req, res) => {
  seen.push({ url: req.url, at: Date.now() });
  const step = plan.shift() ?? { status: 200, body: 'ok' };
  if (step.hang) return;                                     // never answer
  const headers = { 'content-type': step.type ?? 'text/plain', ...(step.headers ?? {}) };
  res.writeHead(step.status, headers);
  res.end(step.body ?? '');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'OK  ' : '★FAIL'} ${name}${detail ? '  — ' + detail : ''}`);
};
const run = async (steps, fn) => { plan = [...steps]; seen = []; return fn(); };

// --- retry decisions ---------------------------------------------------------------
{
  const r = await run([{ status: 503 }, { status: 503 }, { status: 200, body: 'fine' }],
    () => getText(`${BASE}/a`, { base: 5, label: 'a' }));
  check('503 두 번 뒤 성공하면 재시도로 회복', r === 'fine' && seen.length === 3, `요청 ${seen.length}회`);
}
{
  let threw = null;
  await run([{ status: 400 }, { status: 200 }],
    () => getText(`${BASE}/b`, { base: 5, label: 'b' })).catch(e => (threw = e));
  check('400 은 즉시 포기 (재시도 안 함)', threw !== null && seen.length === 1,
        `요청 ${seen.length}회, ${threw?.message ?? '안 던짐'}`);
}
{
  const res = await run([{ status: 404, body: 'nope' }],
    () => get(`${BASE}/c`, { base: 5, label: 'c' }));
  check('404 는 던지지 않고 응답을 돌려줌', res.status === 404, `status ${res.status}`);
}
{
  let threw = null;
  await run(Array(6).fill({ status: 503 }),
    () => getText(`${BASE}/d`, { attempts: 3, base: 5, label: 'd' })).catch(e => (threw = e));
  check('attempts 만큼만 시도하고 마지막에 던짐', threw !== null && seen.length === 3,
        `요청 ${seen.length}회 (기대 3)`);
}
{
  const t0 = Date.now();
  await run([{ status: 503 }, { status: 503 }, { status: 200 }],
    () => getText(`${BASE}/e`, { base: 50, label: 'e' }));
  const took = Date.now() - t0;
  check('백오프가 지수적으로 늘어남 (50 + 100 = 150ms 이상)', took >= 150, `${took}ms`);
}
{
  const t0 = Date.now();
  await run([{ status: 429, headers: { 'retry-after': '1' } }, { status: 200 }],
    () => getText(`${BASE}/f`, { base: 5, label: 'f' }));
  check('Retry-After 를 존중 (1초 이상 대기)', Date.now() - t0 >= 1000, `${Date.now() - t0}ms`);
}

// --- the shapes callers actually depend on -----------------------------------------
{
  const j = await run([{ status: 200, body: '{"x":1}', type: 'application/json' }],
    () => getJson(`${BASE}/g`, { base: 5 }));
  check('getJson 이 파싱된 객체를 돌려줌', j?.x === 1, JSON.stringify(j));
}
{
  // A 404 is returned rather than thrown, and getJson then calls .json() on a body
  // that is not JSON. What does a caller see?
  let out = null, threw = null;
  await run([{ status: 404, body: 'no such room' }],
    () => getJson(`${BASE}/h`, { base: 5, label: 'h' })).then(v => (out = v)).catch(e => (threw = e));
  check('getJson 이 404 를 만났을 때 무엇을 하는가',
        threw !== null,
        threw ? `${threw.constructor.name}: ${threw.message.slice(0, 60)}` : `값 ${JSON.stringify(out)}`);
}
{
  // A request the server never answers.
  const t0 = Date.now();
  let threw = null;
  const p = run([{ hang: true }], () => getText(`${BASE}/i`, { attempts: 1, base: 5, label: 'i', timeout: 800 }))
    .catch(e => (threw = e));
  const timedOut = await Promise.race([p.then(() => false), new Promise(r => setTimeout(() => r(true), 3000))]);
  check('응답하지 않는 요청에 타임아웃이 있는가', !timedOut,
        timedOut ? '3초 동안 매달려 있음 — 타임아웃 없음' : `${Date.now() - t0}ms 만에 종료`);
}

console.log(fails ? `\n★ ${fails}건 실패` : '\n전부 통과');
server.close();
process.exit(fails ? 1 : 0);
