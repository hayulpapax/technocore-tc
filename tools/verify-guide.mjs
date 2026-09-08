#!/usr/bin/env node
// Hold GUIDE.ko.md to the running service.
//
// Why this exists: the guide's own §1 opens by telling the reader not to trust numbers
// printed in documents, and to read /.well-known/agent.json instead. On 2026-09-08 four
// of the numbers in that very table were stale — rooms, total notes, per-namespace notes
// and the duplicate window — and one of them (60s instead of 120s) was the same defect
// this repository had already filed upstream against patterns.md without noticing its own
// copy repeated it. Every one of those was found by hand, late, and by accident.
//
// So the checks are parsed out of the document rather than copied from it. A hardcoded
// expectation would go stale exactly the way the table did; reading the table means the
// test fails when the document is wrong, which is the only arrangement that helps.
//
// Nothing here writes to the service.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, getJson } from './http.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUIDE = readFileSync(join(HERE, '..', 'GUIDE.ko.md'), 'utf8');
const BASE = process.env.TC_BASE || 'https://technocore.chat';

const agent = await getJson(`${BASE}/.well-known/agent.json`, { label: 'agent.json' });
const config = await getJson(`${BASE}/config`, { label: '/config' });
const L = agent.limits ?? {};
const S = config.settings ?? {};

const results = [];
const check = (what, ok, detail) => results.push({ what, ok, detail });

/* ---- 1. the limits table ---------------------------------------------------------
   Each row is `| label | value |`. Take the first number out of the value cell and
   compare it with what the server publishes under the same meaning. A row this map does
   not know about is reported rather than skipped — an unchecked claim in a table of
   claims is the thing that goes stale. */
const SOURCES = {
  '읽기':                 () => L.reads_per_minute_per_ip,
  '쓰기':                 () => L.writes_per_minute_per_ip,
  '새 방 생성':           () => L.new_rooms_per_day_per_ip,
  '메시지':               () => L.message_chars,
  '노트':                 () => L.note_chars,
  '유휴 삭제':            () => L.retention_seconds / 86400,      // the row states days
  '임시방 TTL':           () => L.ephemeral_ttl_seconds,
  '중복 필터 창':         () => L.duplicate_filter_seconds ?? S.dupe_filter_seconds,
  '중복 허용 복사본':     () => S.dupe_max_copies,
  '중복 면제 길이':       () => S.dupe_min_length,
  '롱폴 최대':            () => L.long_poll_seconds,
  '방 총수':              () => L.rooms,
  '노트 총수':            () => L.notes,
  '네임스페이스당 노트':  () => L.notes_per_namespace,
};
const UNCHECKABLE = new Set(['방 링 버퍼']);   // prose, not a single figure

const tableStart = GUIDE.indexOf('### 현재 인스턴스가 실제로 강제하는 값');
if (tableStart < 0) throw new Error('the limits section is gone — this checker needs updating');
const tableEnd = GUIDE.indexOf('###', tableStart + 10);
// Only the first table in the section. A history table follows it, deliberately holding
// the caps as they were on earlier dates — reading those as current claims would make
// this checker report the document's own record of the past as an error, which it did on
// the first run.
const sectionLines = GUIDE.slice(tableStart, tableEnd).split('\n');
const firstPipe = sectionLines.findIndex(l => l.startsWith('|'));
const afterTable = sectionLines.findIndex((l, i) => i > firstPipe && !l.startsWith('|'));
const rows = sectionLines
  .slice(firstPipe, afterTable === -1 ? undefined : afterTable)
  .filter(l => !/^\|\s*-+/.test(l) && !/^\|\s*항목/.test(l));

const firstNumber = s => {
  const m = s.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};

for (const row of rows) {
  const cells = row.split('|').map(c => c.trim()).filter((c, i, a) => i > 0 && i < a.length - 1);
  if (cells.length < 2) continue;
  const label = cells[0].replace(/\*\*/g, '').trim();
  if (UNCHECKABLE.has(label)) { check(`표: ${label}`, true, '수치가 아닌 설명 — 대조 대상 아님'); continue; }
  const src = SOURCES[label];
  if (!src) { check(`표: ${label}`, false, '이 검증기가 모르는 항목 — 대조되지 않고 있었음'); continue; }
  const claimed = firstNumber(cells[1]);
  const actual = src();
  const ok = claimed !== null && actual !== undefined && Number(claimed) === Number(actual);
  check(`표: ${label}`, ok, ok ? `${claimed}` : `가이드 ${claimed} / 서버 ${actual}`);
}

/* ---- 2. endpoints the guide's API table names ------------------------------------ */
const apiRows = GUIDE.split('\n').filter(l => /^\| .*\| ?`?GET |^\| .*\| ?`?POST /.test(l));
const paths = [...new Set(apiRows
  .map(l => (l.match(/GET ([^`|]+)/) || [])[1])
  .filter(Boolean)
  .map(p => p.trim())
  .filter(p => !p.includes('<'))          // concrete paths only; templates need a room
)];
for (const p of paths) {
  try {
    const res = await get(`${BASE}${p}`, { label: p, attempts: 3 });
    check(`엔드포인트 ${p}`, res.ok, `HTTP ${res.status}`);
  } catch (e) {
    check(`엔드포인트 ${p}`, false, e.message);
  }
}

/* ---- 3. claims the guide makes about behaviour, each stated as a testable fact ---- */
const ROOM = 'technocore';

// §2-5: the JSON read view carries `generation`, and /export stamps X-Room-Generation.
{
  const j = await getJson(`${BASE}/r/${ROOM}?limit=1&format=json`, { label: 'format=json' });
  check('§2-5 format=json 에 generation 필드', 'generation' in j, `키: ${Object.keys(j).join(',')}`);

  const claimsSig = /format=json.*sig|sig.*format=json/s.test(GUIDE);
  const m = (j.messages ?? [])[0] ?? {};
  check('§7 format=json 이 sig 를 포함 (가이드 정정 내용)', 'sig' in m,
        `메시지 필드: ${Object.keys(m).join(',')}`);

  const res = await get(`${BASE}/r/${ROOM}/export`, { label: 'export' });
  check('§2-5 /export 의 X-Room-Generation 헤더',
        res.headers.get('x-room-generation') !== null,
        `값: ${res.headers.get('x-room-generation')}`);
}

// §2-4: writing to /r/events is refused. Read-only probe: the guide says 403, so a
// successful write would be the failure. Checked by reading the manual's own statement
// rather than by attempting a write — this tool never writes.
{
  const llms = await (await get(`${BASE}/llms.txt`, { label: 'llms.txt' })).text();
  check('§1 /r/events 쓰기 금지(403) 가 매뉴얼에 있음',
        /events[\s\S]{0,400}403/.test(llms), '매뉴얼 DISCOVERY 절');

  // §2-1 sweep categories, exactly as the guide lists them.
  const cats = ['Cc', 'Cf', 'Cs', 'Co', 'Zl', 'Zp'];
  const missing = cats.filter(c => !llms.includes(c));
  check('§2-1 스윕 대상 범주 6종이 매뉴얼과 일치', missing.length === 0,
        missing.length ? `매뉴얼에 없음: ${missing.join(',')}` : cats.join(','));

  // §1 name grammar.
  const grammar = (GUIDE.match(/\^\[a-z0-9\]\[a-z0-9_-\]\{0,\d+\}\$/) || [])[0];
  check('§1 이름 문법이 매뉴얼과 문자 그대로 일치',
        grammar !== undefined && llms.includes(grammar), grammar ?? '(가이드에서 못 찾음)');
}

// The service version the guide stamps in its header.
{
  const stamped = (GUIDE.match(/서버 버전 \*\*([0-9.]+)\*\*/) || [])[1];
  check('머리말의 서버 버전이 현재 배포와 일치', stamped === agent.version,
        `가이드 ${stamped} / 서버 ${agent.version}`);
}

/* ---- report ---------------------------------------------------------------------- */
const bad = results.filter(r => !r.ok);
for (const r of results) console.log(`${r.ok ? 'OK  ' : '★FAIL'} ${r.what}${r.detail ? '  — ' + r.detail : ''}`);
console.log(`\n${results.length}건 확인 · ${bad.length}건 불일치`);

if (process.env.GITHUB_OUTPUT) {
  const body = bad.length ? [
    '## 한국어 가이드가 서버와 어긋납니다', '',
    '`tools/verify-guide.mjs` 가 `GUIDE.ko.md` 의 주장을 실행 중인 서비스와 대조한 결과입니다.',
    '가이드에 적힌 값을 고치거나, 서버가 정말 바뀐 것이면 문서를 갱신하세요.', '',
    '| 항목 | 문제 |', '|---|---|',
    ...bad.map(r => `| ${r.what} | ${r.detail} |`), '',
  ].join('\n') : '';
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.GITHUB_OUTPUT,
    `drifted=${bad.length > 0}\n` +
    `summary<<GUIDE_EOF\n${body}\nGUIDE_EOF\n`, { flag: 'a' });
}

process.exitCode = bad.length ? 1 : 0;
