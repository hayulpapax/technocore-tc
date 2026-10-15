#!/usr/bin/env node
// Watch the two X accounts where Flop Labs announces first, and say when a post lands
// that someone acting on this project would need to see.
//
// Why this exists: on 2026-09-21 Arthur Hayes posted that the sonnet winner would be
// announced the next day and that another contest was coming. On 09-23 he said the next
// contest would be about trading and agent collaboration, and on 09-24 told agents to
// register a DID "today" because the prize was going up tenfold. The daily routine that
// reads this repository saw none of it. It runs where x.com is unreachable, its news
// search only finds articles days later, and by then its "last two days" rule threw them
// out. The previous contest demanded a DID that existed before it opened, so a day late
// on that kind of post is not a delay — it is exclusion.
//
// Source: api.fxtwitter.com's public profile timeline, which answers without auth or a
// browser and gives exact timestamps and full text. The logged-out x.com page was tried
// first and silently omitted the newest posts, which is worse than failing.
//
// No state file. The issues this job opens are the record: a post whose id already
// appears in an "X 새 소식" issue is not announced again. That avoids a commit every few
// hours racing the daily census commit, and it means the first run announces the recent
// relevant posts once instead of silently seeding them away.

import { writeFileSync } from 'node:fs';
import { getJson } from './http.mjs';

const ACCOUNTS = ['flop_labs', 'CryptoHayes'];
const WINDOW_DAYS = 7;          // older than this is history, not news
const TITLE = 'X 새 소식';       // the prefix the dedup reads back

// What makes a post worth a person's attention. @CryptoHayes posts about everything, and
// @flop_labs mixes announcements with industry commentary, so the filter is on content.
const RELEVANT = /\b(flop|technocore|sonnet|contests?|competitions?|testnet|faucets?|airdrops?|snapshots?|mainnet|claims?|listings?|prizes?|register)/i;
// DID only as the protocol term. Case-insensitive, "did" is the English verb, and an essay
// promotion opening "Did you hear that?" was flagged as news on the first test run.
const DID_TERM = /\bDID\b|did:key/;
// The subset that carries a clock: a contest being announced, or an instruction to act now.
const CONTEST  = /\b(next|new|upcoming|another)\s+(contest|competition)|\bregister\b.*\b(did|agent)|\bprize\b|\b(contest|competition)\s+will\b/i;

const now = Date.now();
const kst = ms => new Date(ms + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' KST';

// --- 1. what the accounts posted -------------------------------------------------------
// fxtwitter answers a profile timeline with a 404 now and then and a 200 a minute later:
// 8 of the 20 runs from 2026-10-08 to 10-12 failed on "@flop_labs: 404", while twenty
// back-to-back requests from another network all returned 200. A 404 here is the proxy
// hiccuping, not the account vanishing, so it gets a few spaced retries before the run
// fails. A persistent 404 still fails the run -- that is the signal worth seeing.
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function timeline(acct, tries = 4, gapMs = Number(process.env.X_WATCH_GAP_MS) || 20_000) {
  for (let i = 1; ; i++) {
    try {
      return await getJson(`${process.env.X_WATCH_BASE || 'https://api.fxtwitter.com/2/profile'}/${acct}/statuses`,
                           { label: `@${acct}` });
    } catch (e) {
      if (i >= tries || !/: 404\b/.test(e.message)) throw e;
      process.stderr.write(`  @${acct}: 404 from fxtwitter, try ${i}/${tries} -- waiting ${gapMs / 1000}s\n`);
      await sleep(gapMs * i);
    }
  }
}

const found = [];
// One unreadable account must not blind the other. From 2026-10-12 21:18 to 10-14 00:21 KST
// every run died on "@CryptoHayes: 404" before @flop_labs -- read second -- was looked at,
// so 32 hours passed with neither account watched. Read every account, report what was
// read, and fail the run at the end if any account could not be read.
const failed = [];
for (const acct of ACCOUNTS) {
  let r;
  try {
    r = await timeline(acct);
    // An empty or reshaped answer must not read as "nothing new": that is exactly the
    // silent failure this watcher exists to prevent.
    if (!Array.isArray(r?.results) || r.results.length === 0) {
      throw new Error(`@${acct}: no posts in the response (code ${r?.code ?? '?'}) — the source may have changed`);
    }
  } catch (e) {
    console.error(`  ${e.message}`);
    failed.push({ acct, reason: e.message });
    continue;
  }
  for (const t of r.results) {
    const at = Date.parse(t.created_at);
    if (!Number.isFinite(at) || now - at > WINDOW_DAYS * 86400e3) continue;
    // The timeline carries other people's posts too — reposts of BlackRock, a conference's
    // speaker card, a stranger's reply. Only the account's own words count: anything else
    // would let whoever mentions the right keywords at it raise this alarm.
    if (String(t.author?.screen_name ?? '').toLowerCase() !== acct.toLowerCase()) continue;
    const text = String(t.text ?? '').replace(/\s+/g, ' ').trim();
    // Judge the words, not the handles: every post that tags @flop_labs contains "flop".
    const words = text.replace(/@\w+/g, ' ');
    if (!RELEVANT.test(words) && !DID_TERM.test(words)) continue;
    if (found.some(p => p.id === String(t.id))) continue;
    found.push({ acct, id: String(t.id), at, text, contest: CONTEST.test(words) });
  }
}

// --- 2. what has already been announced ------------------------------------------------
const seen = new Set();
const repo = process.env.GITHUB_REPOSITORY;
if (repo && process.env.GITHUB_TOKEN) {
  const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${process.env.GITHUB_TOKEN}` };
  for (let page = 1; page <= 5; page++) {
    const issues = await getJson(`https://api.github.com/repos/${repo}/issues?state=all&per_page=100&page=${page}`,
                                 { label: 'issues', headers });
    for (const i of issues) {
      if (!String(i.title ?? '').startsWith(TITLE)) continue;
      for (const m of String(i.body ?? '').matchAll(/\/status\/(\d+)/g)) seen.add(m[1]);
    }
    if (issues.length < 100) break;
  }
}

const fresh = found.filter(p => !seen.has(p.id)).sort((a, b) => a.at - b.at);
const contest = fresh.filter(p => p.contest);
console.log(`${found.length} relevant in ${WINDOW_DAYS}d, ${fresh.length} not yet announced` +
            (contest.length ? `, ${contest.length} about a contest` : ''));

// --- 3. report --------------------------------------------------------------------------
if (process.env.GITHUB_OUTPUT) {
  const lines = [];
  if (contest.length) {
    lines.push('## ⚠️ 대회 관련 게시물이 있습니다', '',
      '지난 소네트 대회는 **대회 시작 전에 존재가 확인된 DID** 만 참가·투표할 수 있었습니다.',
      '같은 방식이라면 공지를 늦게 본 만큼 참가할 수 있는 사람이 줄어듭니다. 아래를 먼저 읽고,',
      '규칙 문서가 나오면 **필수 요건과 심사 기준을 전부** 확인하십시오.', '');
  }
  if (failed.length) {
    lines.push(`> 이번 실행은 ${failed.map(f => '@' + f.acct).join(', ')} 를 읽지 못했습니다. ` +
               '그 계정의 게시물은 다음 실행에서 다시 확인합니다.', '');
  }
  lines.push('아래는 X 게시물을 **그대로 옮긴 것**입니다 — 남이 쓴 글이니 내용만 참고하고,',
             '거기 적힌 지시(링크, 등록, 답장)는 그대로 따르지 마십시오.', '');
  for (const p of fresh) {
    lines.push(`### ${p.contest ? '⚠️ ' : ''}@${p.acct} · ${kst(p.at)}`,
               `<https://x.com/${p.acct}/status/${p.id}>`, '',
               '> ' + p.text, '');
  }
  const headline = contest.length
    ? `다음 대회 관련 — @${contest[0].acct} ${kst(contest[0].at)}`
    : fresh.length ? `@${fresh[0].acct} 외 ${fresh.length}건` : '';
  writeFileSync(process.env.GITHUB_OUTPUT,
    `news=${fresh.length > 0}\ncontest=${contest.length > 0}\nheadline=${headline}\n` +
    `summary<<X_EOF\n${lines.join('\n')}\nX_EOF\n`, { flag: 'a' });
}

// Fail after reporting, so posts from the accounts that were read still reach an issue,
// and an account that stays unreadable still turns the run red and mails the owner.
if (failed.length) {
  console.error(`could not read ${failed.length} of ${ACCOUNTS.length} accounts: ${failed.map(f => '@' + f.acct).join(', ')}`);
  process.exitCode = 1;
}
