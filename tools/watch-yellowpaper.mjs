#!/usr/bin/env node
// Watch the yellowpaper for changes to the values it pins, and say which ones moved.
//
// Why this exists: on 2026-09-24 17:12Z the yellowpaper synced decision D-0440 — genesis
// supply 3.5bn → 4.4bn, validator airdrop 305.5M → 1.2bn, validator bond 305,505 →
// 1,200,000 FLOP. That is the one change the daily routine's reference table names as big
// news ("the expansion was ratified"), and nothing was watching for it: the releases watch
// looks for tags and new repositories, and the yellowpaper ships as commits to main. The
// routine found out a day later, by accident, while chasing something else.
//
// Appendix A lists every parameter of record, one row each. Diffing that table by name
// says exactly what moved — "genesis_supply 3_500_000_000 FLOP → 4_400_000_000 FLOP" —
// rather than "the document changed". A sync that moves no value is still reported, as
// prose, because that same sync also added open items E.9 and E.57 from issues we filed.
//
// State lives in data/yellowpaper-watch.json. The first run seeds it and announces nothing.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getJson, getText } from './http.mjs';

const HERE  = dirname(fileURLToPath(import.meta.url));
const STATE = process.env.YP_STATE || join(HERE, '..', 'data', 'yellowpaper-watch.json');
const REPO  = 'flop-labs/yellowpaper';
const FILE  = 'yellowpaper.md';
const TICK  = '`';
const code  = s => TICK + s + TICK;

const auth = process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
const gh = p => getJson(`https://api.github.com${p}`, { label: p, headers: { accept: 'application/vnd.github+json', ...auth } });

// The parameters the routine's reference table is built from. A move here is the headline.
const WATCHED = /^genesis_|airdrop|supply|validator_min_stake|min_miner_self_stake|unbonding/;

// --- 1. the current text ----------------------------------------------------------------
// YP_AT pins a commit, for testing the diff against a known change.
const ref = process.env.YP_AT || null;
const commits = await gh(`/repos/${REPO}/commits?path=${FILE}&per_page=1${ref ? `&sha=${ref}` : ''}`);
const head = Array.isArray(commits) ? commits[0] : null;
if (!head?.sha) throw new Error(`yellowpaper: no commit found for ${FILE}`);
const text = await getText(`https://raw.githubusercontent.com/${REPO}/${head.sha}/${FILE}`, { label: FILE });

const params = {};
for (const line of text.split('\n')) {
  const m = line.match(/^\|\s*<a id="param-([a-z0-9_]+)"><\/a>`\1`\s*\|\s*([^|]+?)\s*\|/);
  if (m) params[m[1]] = m[2];
}
// A table this watcher cannot read must not look like a table where nothing changed.
const count = Object.keys(params).length;
if (count < 20) throw new Error(`yellowpaper: parsed only ${count} parameters at ${head.sha.slice(0, 7)} — the table format may have changed`);

// --- 2. against what was last seen ------------------------------------------------------
let prev = null;
if (existsSync(STATE)) {
  try { prev = JSON.parse(readFileSync(STATE, 'utf8')); }
  catch (err) { process.stderr.write(`  state unreadable (${err.message}) — reseeding\n`); }
}
const first = !prev?.commit;
const moved = !first && prev.commit !== head.sha;
const changed = [], added = [], removed = [];
if (moved) {
  for (const [k, v] of Object.entries(params)) {
    if (!(k in prev.params)) added.push([k, v]);
    else if (prev.params[k] !== v) changed.push([k, prev.params[k], v]);
  }
  for (const k of Object.keys(prev.params)) if (!(k in params)) removed.push([k, prev.params[k]]);
}
const paramNews = changed.length + added.length + removed.length > 0;

mkdirSync(dirname(STATE), { recursive: true });
writeFileSync(STATE, JSON.stringify({
  checked_at: new Date().toISOString(),
  commit: head.sha,
  commit_date: head.commit?.committer?.date ?? null,
  message: String(head.commit?.message ?? '').split('\n')[0],
  params,
}, null, 1) + '\n');

console.log(first ? `seeded: ${count} parameters at ${head.sha.slice(0, 7)}`
  : moved ? `moved ${prev.commit.slice(0, 7)} -> ${head.sha.slice(0, 7)}: ${changed.length} changed, ${added.length} added, ${removed.length} removed`
  : `unchanged at ${head.sha.slice(0, 7)} (${count} parameters)`);

// --- 3. report --------------------------------------------------------------------------
if (process.env.GITHUB_OUTPUT) {
  const lines = [];
  const watched = changed.filter(([k]) => WATCHED.test(k));
  if (moved) {
    lines.push(paramNews ? '## 옐로페이퍼 파라미터가 바뀌었습니다' : '## 옐로페이퍼 본문이 바뀌었습니다 (파라미터 값은 그대로)', '',
      `커밋 [${code(head.sha.slice(0, 7))}](https://github.com/${REPO}/commit/${head.sha}) · ` +
      `${head.commit?.committer?.date ?? '?'} · ${String(head.commit?.message ?? '').split('\n')[0]}`,
      `직전 확인분과 비교: <https://github.com/${REPO}/compare/${prev.commit.slice(0, 7)}...${head.sha.slice(0, 7)}>`, '');
    if (watched.length) {
      lines.push('**에어드랍·공급 관련 값이 바뀌었습니다.** 루틴의 기준표가 이 값들로 만들어져 있으니, 기준표도 갱신이 필요합니다.', '',
        '| 파라미터 | 이전 | 현재 |', '|---|---|---|',
        ...watched.map(([k, a, b]) => `| ${code(k)} | ${a} | **${b}** |`), '');
    }
    const rest = changed.filter(([k]) => !WATCHED.test(k));
    if (rest.length) {
      lines.push(`그 밖에 바뀐 값 ${rest.length}개:`, '', '| 파라미터 | 이전 | 현재 |', '|---|---|---|',
        ...rest.map(([k, a, b]) => `| ${code(k)} | ${a} | ${b} |`), '');
    }
    if (added.length)   lines.push(`새로 생긴 파라미터: ${added.map(([k, v]) => `${code(k)} = ${v}`).join(', ')}`, '');
    if (removed.length) lines.push(`없어진 파라미터: ${removed.map(([k]) => code(k)).join(', ')}`, '');
    if (!paramNews)     lines.push('파라미터 값은 하나도 바뀌지 않았습니다. 본문(미결 항목, 설명)만 바뀌었으니 위 비교 링크에서 확인하십시오.', '');
  }
  const top = watched[0] ?? changed[0];
  const headline = !moved ? ''
    : top ? `${top[0]} ${top[1]} → ${top[2]}${changed.length > 1 ? ` 외 ${changed.length - 1}건` : ''}`
    : paramNews ? `파라미터 ${added.length + removed.length}개 추가·삭제`
    : String(head.commit?.message ?? '').split('\n')[0].slice(0, 80);
  writeFileSync(process.env.GITHUB_OUTPUT,
    `ran=true\nnews=${moved}\nparams=${paramNews}\nheadline=${headline}\n` +
    `summary<<YP_EOF\n${lines.join('\n')}\nYP_EOF\n`, { flag: 'a' });
}
