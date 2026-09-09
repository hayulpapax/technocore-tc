#!/usr/bin/env node
// Write BRIEFING.ko.md — one Korean page saying what changed today, and saying so
// explicitly when nothing did.
//
// Why a committed file rather than a notification: the daily briefing that reads this
// runs somewhere with no network except a mailbox, and the mail it was supposed to read
// never arrives (GitHub does not mail the owner about a bot's issue in their own
// repository). A file in the repository has no such gap — whatever can check the
// repository out can read it, and it is the same text every reader sees.
//
// The other half of the reason is that "nothing happened" has to be *stated*. A reader
// that finds no news cannot tell the difference between a quiet day and a broken watch.
// This file always says which of the two it was, and when it last looked.
//
// The findings come in as environment variables from the steps that produced them, so
// this stays a formatter and never re-fetches anything. Census numbers are read from the
// history file, which is the same source the chart draws.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// TC_OUT points the history it reads and the page it writes at another directory, so
// tools/test-briefing.mjs can drive it without touching the real record — the same
// affordance census.mjs takes, for the same reason.
const ROOT = process.env.TC_OUT || join(HERE, '..');

// The census writes an empty legacy cell when that namespace would not serve the read.
// `+''` is 0, and a 0 here became "레거시 경로 노트 0 (-163,194, -100%)" under a line
// saying the census was complete. Keep it null and say it was not read.
const cell = s => (s === '' || s === undefined ? null : +s);
const rows = readFileSync(join(ROOT, 'data', 'census-history.tsv'), 'utf8')
  .trim().split('\n').slice(1).map(l => {
    const f = l.split('\t');
    return {
      date: f[0], at: f[1], version: f[2],
      sharded: +f[3], legacy: cell(f[4]), cap: cell(f[5]), atCap: f[6] === 'true',
      unreadable: +f[10], median: +f[12],
    };
  });
const last = rows[rows.length - 1];
const prev = rows[rows.length - 2];

const env = k => (process.env[k] || '').trim();
const on = k => env(k) === 'true';

// KST is what the reader thinks in; UTC is what the service stamps. Both, always — a
// briefing that gives only one of them makes the reader do arithmetic to place an event.
const kstDate = iso => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : new Date(d.getTime() + 9 * 3600 * 1000);
};
const p = n => String(n).padStart(2, '0');
const kstDay = iso => {
  const k = kstDate(iso);
  return k ? `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())}` : null;
};
const kst = iso => {
  const k = kstDate(iso);
  return k ? `${kstDay(iso)} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())} KST` : '(시각 불명)';
};

const num = n => (n === null ? '읽지 못함' : n.toLocaleString('en-US'));
const delta = (now, before) => {
  if (now === null) return '—';
  if (before === undefined || before === null) return '—';
  const d = now - before;
  if (d === 0) return '변화 없음';
  const pct = before ? ((100 * d) / before).toFixed(1) : '?';
  return `${d > 0 ? '+' : ''}${num(d)} (${d > 0 ? '+' : ''}${pct}%)`;
};

// A six-figure swing in the population is news on its own — this repository has published
// claims about that number, and a day it moves by a sixth is not a quiet day.
const BIG_MOVE = 100_000;
const move = prev ? last.sharded - prev.sharded : 0;
const bigMove = Math.abs(move) >= BIG_MOVE;

// Each watcher reports two things: whether it ran to the end, and whether it found news.
// They used to be one thing. A watcher that crashed left its variables unset, unset read
// as "false", and false read as "checked — nothing new", so the page listed the crashed
// watch under "오늘 확인한 것들 (전부 변화 없음)" and closed with "실제로 조용한 하루였습니다".
// A missing check is not a clean check, and this page is the one place that has to know
// the difference.
const WATCHES = [
  { key: 'DRIFT',    news: 'DRIFT_CHANGED',  label: 'technocore.chat 프로토콜 문서 7종' },
  { key: 'RELEASES', news: 'RELEASES_NEWS',  label: 'flop-labs 조직의 새 릴리스·태그·저장소' },
  { key: 'TCLK',     news: 'TCLK_REPLIED',   label: 'tclk·technocore-chat 에 남긴 글의 답글' },
  { key: 'GUIDE',    news: 'GUIDE_DRIFTED',  label: '한국어 가이드의 수치·동작 주장 (서버와 대조)' },
];
for (const w of WATCHES) { w.ran = on(`${w.key}_RAN`); w.found = w.ran && on(w.news); }
const watch = key => WATCHES.find(w => w.key === key);
const notRun = WATCHES.filter(w => !w.ran);

const drift    = watch('DRIFT').found;
const project  = drift && on('DRIFT_PROJECT');
const releases = watch('RELEASES').found;
const tclk     = watch('TCLK').found;
const guideOff = watch('GUIDE').found;
const anyNews  = drift || releases || tclk || guideOff || bigMove;
const quiet    = !anyNews && notRun.length === 0;

// The headline is what a push notification would carry, so it names the most consequential
// thing first: the project site, then a shipped version, then a reply, then the numbers —
// and a watch that did not run before a quiet day, because "quiet" is a claim the
// missing watch cannot support.
const headline =
  project  ? 'flop.finance 페이지가 바뀌었습니다 — 테스트넷·faucet·에어드랍이 올라오는 곳입니다'
: releases ? `flop-labs가 새로 배포했습니다 — ${env('RELEASES_HEADLINE') || '릴리스 확인'}`
: drift    ? 'technocore.chat 프로토콜 문서가 바뀌었습니다 — 클라이언트가 틀려질 수 있습니다'
: tclk     ? '우리가 남긴 글에 답글이 달렸습니다'
: guideOff ? '한국어 가이드가 서버와 어긋납니다 — 공개 문서가 틀린 값을 싣고 있습니다'
: bigMove  ? `노트 수가 하루 만에 ${num(Math.abs(move))}개 ${move < 0 ? '줄었습니다' : '늘었습니다'}`
: notRun.length ? `감시 ${notRun.length}건이 실행되지 않았습니다 — 그 항목은 새 소식 여부를 알 수 없습니다`
:            '새 소식 없음 — 감시는 정상 동작했습니다';

// If the census step fails, this file is never rewritten and the previous day's copy stays
// in the repository — where the routine that reads it has no way to tell yesterday's news
// from today's. Stamp the age against the moment of writing so a stale copy says so itself,
// rather than relying on whoever reads it to check a timestamp further down the page.
const ageHours = (Date.now() - new Date(last.at).getTime()) / 3_600_000;
const stale = !(ageHours < 30);           // NaN-safe: an unparseable stamp counts as stale

// "Today" is a KST day here, because the reader's day is. Compared at the moment this
// page is written: in the daily job that is minutes after the census, so the check
// passes and the branch below stays quiet; it exists for a page rebuilt by hand on a
// later day, or read out of a checkout the job never refreshed.
const measuredDay = kstDay(last.at);
const todayKST = kstDay(new Date().toISOString());
const isToday = measuredDay !== null && measuredDay === todayKST;

const out = [
  `# FLOP 일일 브리핑 — 조사 ${kst(last.at)}${isToday ? '' : '  (오늘 조사 전)'}`,
  '',
  ...(isToday ? [] : [
    `> ℹ️ **이 수치는 ${measuredDay ?? last.date} 조사분입니다. 오늘(${todayKST}) 조사는 아직 돌지 않았습니다.**`,
    '> 아래 내용은 이미 보고된 것과 같습니다 — **새 소식이 아닙니다.**',
    '> 정기 조사는 02:15 UTC 예약이지만 GitHub 대기열 때문에 실제로는 대개 07~09시 UTC(16~18시 KST)에 돕니다.',
    '',
  ]),
  ...(stale ? [
    `> ⚠️ **이 브리핑은 오래됐습니다.** 가장 최근 조사가 ` +
    `${Number.isFinite(ageHours) ? Math.round(ageHours) + '시간 전' : '언제인지 불명'}입니다. ` +
    `감시가 멈췄을 수 있으니, 아래 내용을 오늘 소식으로 보고하지 마십시오.`, '',
  ] : []),
  `**${isToday ? headline : `[${measuredDay ?? last.date} 조사분 · 새 소식 아님] ${headline}`}**`,
  '',
  `- 조사 시각: ${kst(last.at)} (원문 ${last.at} UTC) — ${Number.isFinite(ageHours) ? `${Math.round(ageHours)}시간 전` : '시각 불명'}`,
  `- 서비스 버전: \`${last.version}\`${prev && prev.version !== last.version ? ` — 어제 \`${prev.version}\` 에서 올라감` : ''}`,
  `- 조사 횟수: ${rows.length}회 (${rows[0].date}부터)`,
  '',
  '## 수치',
  '',
  '| | 오늘 | 어제 대비 |',
  '|---|---|---|',
  `| 현행 샤딩 경로 노트 | ${num(last.sharded)} | ${delta(last.sharded, prev?.sharded)} |`,
  `| 레거시 경로 노트 | ${num(last.legacy)} | ${delta(last.legacy, prev?.legacy)} |`,
  `| 레거시 상한 | ${num(last.cap)}${last.atCap ? ' **(상한 도달)**' : ''} | ${delta(last.cap, prev?.cap)} |`,
  `| 샤드당 중앙값 | ${num(last.median)} | ${delta(last.median, prev?.median)} |`,
  '',
  last.unreadable > 0 || last.legacy === null
    ? `> ⚠️ ${last.unreadable > 0 ? `샤드 ${last.unreadable}개` : ''}${last.unreadable > 0 && last.legacy === null ? '와 ' : ''}${last.legacy === null ? '레거시 네임스페이스' : ''}를 읽지 못했습니다. 위 수치는 실제보다 **적게** 나온 값이거나 비어 있습니다.`
    : '읽기 실패한 샤드 없음 — 위 수치는 전수 조사 결과입니다.',
  '',
];

// A large move is worth naming even on a day nothing else happened, because the count
// falling is the one thing this repository has published a claim about.
if (bigMove) {
  const d = move;
  out.push(
    d < 0 ? '## 하루 만에 크게 줄었습니다' : '## 하루 만에 크게 늘었습니다', '',
    `노트 수가 ${num(prev.sharded)} → ${num(last.sharded)} 로 ${num(Math.abs(d))}개 ` +
    `${d < 0 ? '감소' : '증가'}했습니다. 샤드당 중앙값도 ${num(prev.median)} → ${num(last.median)} 로 ` +
    `같이 움직였으므로, 일부 샤드만의 문제가 아니라 전체에 걸친 변화입니다.`, '',
    d < 0 ? '노트는 7일간 쓰기가 없으면 삭제됩니다(`retention_seconds: 604800`). ' +
            '7일 전에 크게 늘었다면 그 물결이 만료된 것과 일치합니다 — 다만 서버가 ' +
            '그렇게 공지한 것은 아니므로 단정하지는 마십시오.' : '', '');
}

if (project || drift) {
  out.push('## 문서가 바뀌었습니다', '', env('DRIFT_SUMMARY') || '(요약 없음)', '');
}
if (releases) {
  out.push('## flop-labs 배포/저장소', '', env('RELEASES_SUMMARY') || '(요약 없음)', '');
}
if (tclk) {
  out.push('## 답글', '', env('TCLK_SUMMARY') || '(요약 없음)', '');
}
if (guideOff) {
  out.push('## 한국어 가이드 불일치', '', env('GUIDE_SUMMARY') || '(요약 없음)', '');
}

// What was checked, item by item, with the ones that were not checked named as such.
// Written on every day, not only quiet ones: a day with one piece of news and one
// crashed watcher is still a day the reader has to be told about the crash.
out.push('## 오늘 확인한 것들', '');
for (const w of WATCHES) {
  out.push(`- ${w.label} — ${!w.ran ? '**확인 못 함 (감시 실행 실패)**' : w.found ? '**변화 있음** (위 참조)' : '변화 없음'}`);
}
out.push('');
if (quiet) {
  out.push('감시가 멈춘 것이 아니라, 실제로 조용한 하루였습니다.', '');
} else if (notRun.length) {
  out.push(`감시 ${notRun.length}건이 끝까지 돌지 못했습니다(${notRun.map(w => w.key).join(', ')}). ` +
           '그 항목에 대해서는 "새 소식 없음"이라고 말할 수 없습니다 — 워크플로 로그를 확인하십시오.', '');
}

out.push('---', '',
  '이 파일은 `tools/briefing.mjs` 가 매일 자동으로 다시 씁니다. 사람이 고치면 다음 실행에 덮어씁니다.',
  '수치의 원본은 [`data/census-history.tsv`](data/census-history.tsv), 그래프는 [`CENSUS.md`](CENSUS.md) 에 있습니다.');

writeFileSync(join(ROOT, 'BRIEFING.ko.md'), out.join('\n') + '\n');
console.log(`briefing written: ${quiet ? 'quiet day' : notRun.length && !anyNews ? 'incomplete' : 'news'} — ${headline}`);
