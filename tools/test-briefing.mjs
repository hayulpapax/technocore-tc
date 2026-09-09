#!/usr/bin/env node
// The briefing is read out loud by a daily routine that cannot remember what it said
// yesterday. Everything it needs in order not to repeat itself has to be on the page.
//
// On 2026-09-09 at 09:58 KST that routine read this page and reported a census taken at
// 10:00 KST the previous day as "실제 변화가 있어" — a day-old measurement delivered as
// news. Nothing was broken: the history takes one row per day, written by that day's
// first run, so between then and the next run every reader sees the same numbers. The
// timestamp was on the page and the framing still came out wrong, because a timestamp is
// something a reader has to interpret and a headline is something they quote.
//
// So the marker lives in the headline, and these tests hold it there.
//
// TC_OUT sends both the history it reads and the page it writes to a temp directory.
// No network. Run: node tools/test-briefing.mjs
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const HEADER = ['date', 'measured_at', 'service_version', 'sharded_total', 'legacy_total',
  'legacy_namespace_cap', 'legacy_at_cap', 'rooms_enumerated', 'rooms_cap',
  'shards_with_notes', 'shards_unreadable', 'shard_min', 'shard_median', 'shard_max'];

const row = (date, at, sharded, median) =>
  [date, at, '0.13.0', sharded, 1000, 1000, 'true', 50, 100, 256, 0, 1, median, 9].join('\t');

const dayOf = d => d.toISOString().slice(0, 10);
const now = new Date();
const daysAgo = n => new Date(now.getTime() - n * 86_400_000);

// Two rows so the briefing has a delta to describe.
const run = async rows => {
  const out = mkdtempSync(join(tmpdir(), 'tc-brief-'));
  mkdirSync(join(out, 'data'), { recursive: true });
  writeFileSync(join(out, 'data', 'census-history.tsv'),
    [HEADER.join('\t'), ...rows].join('\n') + '\n');
  try {
    const { stdout } = await execFileAsync(process.execPath, ['tools/briefing.mjs'],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, TC_OUT: out } });
    return { page: readFileSync(join(out, 'BRIEFING.ko.md'), 'utf8'), stdout };
  } finally { rmSync(out, { recursive: true, force: true }); }
};

let fails = 0;
const check = (name, ok, detail) => {
  if (!ok) fails++;
  console.log(`${ok ? 'OK  ' : '★FAIL'} ${name}${detail ? '\n        ' + detail : ''}`);
};
const headlineOf = page => (page.match(/^\*\*(.+)\*\*$/m) || [, '(헤드라인 없음)'])[1];

// --- today's census, with a big move to report --------------------------------------
{
  const { page } = await run([
    row(dayOf(daysAgo(1)), daysAgo(1).toISOString(), 2_000_000, 8000),
    row(dayOf(now), now.toISOString(), 1_700_000, 6800),
  ]);
  const h = headlineOf(page);
  check('오늘 조사분이면 헤드라인에 군더더기가 붙지 않는다',
        !h.includes('새 소식 아님') && h.includes('줄었습니다'), h);
  check('오늘 조사분이면 "오늘 조사 전" 안내가 없다',
        !page.includes('오늘 조사 전'), page.split('\n')[0]);
}

// --- yesterday's census, nothing new since ------------------------------------------
{
  const two = daysAgo(2), one = daysAgo(1);
  const { page } = await run([
    row(dayOf(two), two.toISOString(), 2_000_000, 8000),
    row(dayOf(one), one.toISOString(), 1_700_000, 6800),
  ]);
  const h = headlineOf(page);
  check('어제 조사분이면 헤드라인 자체가 "새 소식 아님" 을 달고 나온다',
        h.includes('새 소식 아님') && h.includes(dayOf(one)), h);
  check('어제 조사분이면 제목과 본문이 오늘 조사 전임을 밝힌다',
        page.includes('오늘 조사 전') && /오늘\([0-9-]+\) 조사는 아직 돌지 않았습니다/.test(page),
        page.split('\n')[0]);
  check('나이를 시간 단위로 항상 적는다',
        /조사 시각:.*시간 전/.test(page),
        (page.match(/^- 조사 시각:.*$/m) || [''])[0].slice(0, 88));
}

// --- an old census: the watch may actually be broken ---------------------------------
{
  const four = daysAgo(4), three = daysAgo(3);
  const { page } = await run([
    row(dayOf(four), four.toISOString(), 2_000_000, 8000),
    row(dayOf(three), three.toISOString(), 1_700_000, 6800),
  ]);
  check('30시간을 넘기면 "감시가 멈췄을 수 있다" 경고가 따로 붙는다',
        page.includes('오래됐습니다') && page.includes('감시가 멈췄을 수 있으니'),
        '두 신호는 다른 것이다: 아직 안 돈 것과 멈춘 것');
}

// --- a quiet day still has to say it was checked -------------------------------------
{
  const one = daysAgo(1);
  const { page } = await run([
    row(dayOf(one), one.toISOString(), 1_700_000, 6800),
    row(dayOf(now), now.toISOString(), 1_700_050, 6801),      // tiny move, no news
  ]);
  check('조용한 날은 무엇을 확인했는지 나열한다',
        page.includes('새 소식 없음') && page.includes('감시가 멈춘 것이 아니라'),
        headlineOf(page));
}

console.log(fails ? `\n★ ${fails}건 실패` : '\n전부 통과');
process.exit(fails ? 1 : 0);
