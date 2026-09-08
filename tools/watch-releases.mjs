#!/usr/bin/env node
// Watch flop-labs for the events that actually carry news, and say when one lands.
//
// The reason this exists: a daily search of the news and the inbox reports "nothing
// new" almost every day, because almost nothing about this project is ever written up
// anywhere. Meanwhile the operator shipped 0.11.2, 0.11.3, 0.11.4, 0.12.1 and 0.13.0
// inside nine days. The news is real; it is just published as tags and repositories
// rather than as articles, and neither a web search nor an inbox will ever show it.
//
// Three signals, none of which a search engine can produce:
//
//   1. a new release in any flop-labs repository — the operator declaring a version
//   2. a new repository in the org — a testnet, a faucet or an inference API would
//      appear here first, and this is the announcement actually being waited on
//   3. the version technocore.chat is serving — the tag and the deployment are two
//      events, and this client talks to the deployment
//
// Releases rather than commits: commits are constant here and "something changed" is
// not information. A tag is the operator saying a thing is done.
//
// State lives in data/releases-watch.json so each release is announced once. The first
// run seeds that file and announces nothing, so adopting this does not open an issue
// listing every release already shipped.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getJson } from './http.mjs';

const HERE  = dirname(fileURLToPath(import.meta.url));
const DATA  = join(HERE, '..', 'data');
const STATE = join(DATA, 'releases-watch.json');
const ORG   = process.env.FLOP_ORG || 'flop-labs';
const API   = 'https://api.github.com';
const AGENT = 'https://technocore.chat/.well-known/agent.json';

// GitHub rejects unauthenticated bursts quickly; Actions always has a token.
const auth = process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
const gh = path => getJson(`${API}${path}`, { label: path, headers: { accept: 'application/vnd.github+json', ...auth } });

const prev = existsSync(STATE)
  ? JSON.parse(readFileSync(STATE, 'utf8'))
  : null;
const first = prev === null;

const seenReleases = new Set(prev?.releases ?? []);
const seenRepos    = new Set(prev?.repos ?? []);

const news = { releases: [], repos: [], version: null };

// --- 1 & 2: repositories and their releases ----------------------------------------
// Listing the org rather than a hardcoded list is the point of signal 2: a repository
// that does not exist yet is exactly the one worth hearing about.
const repos = await gh(`/orgs/${ORG}/repos?per_page=100&sort=created&direction=desc`);
const repoNames = (Array.isArray(repos) ? repos : []).map(r => r.name);

for (const repo of Array.isArray(repos) ? repos : []) {
  if (!seenRepos.has(repo.name) && !first) {
    news.repos.push({
      name: repo.name,
      url: repo.html_url,
      created: repo.created_at?.slice(0, 10) ?? '?',
      description: repo.description || '(no description)',
    });
  }

  // A repo with no releases answers 200 with an empty array, so this is not an error path.
  let releases = [];
  try {
    releases = await gh(`/repos/${ORG}/${repo.name}/releases?per_page=10`);
  } catch (err) {
    // One unreadable repository must not lose the other signals in this run. Record it
    // as unseen so the next run tries again rather than treating it as reported.
    console.error(`releases unreadable for ${repo.name}: ${err.message}`);
    continue;
  }

  for (const rel of Array.isArray(releases) ? releases : []) {
    if (rel.draft) continue;
    const id = `${repo.name}@${rel.tag_name}`;
    if (seenReleases.has(id)) continue;
    seenReleases.add(id);
    if (first) continue;               // seeding, not announcing
    news.releases.push({
      repo: repo.name,
      tag: rel.tag_name,
      name: rel.name || rel.tag_name,
      url: rel.html_url,
      published: rel.published_at ?? rel.created_at,
      // The notes are the operator's own words about what changed — the one place a
      // "deployer note" or a breaking change is stated in full. Keep the opening, not
      // the whole body: an issue nobody reads is the same as no issue.
      excerpt: (rel.body || '').split('\n').filter(l => l.trim()).slice(0, 6).join('\n'),
    });
  }
}
for (const n of repoNames) seenRepos.add(n);

// --- 3: what the deployment is actually serving -------------------------------------
// Separate from the tag on purpose. A tag can sit unreleased and a deployment can move
// without one; the number that decides whether this client is correct is this one.
let liveVersion = prev?.live_version ?? null;
try {
  const agent = await getJson(AGENT, { label: 'agent.json' });
  const now = agent?.version ?? null;
  if (now && now !== prev?.live_version) {
    if (!first) news.version = { from: prev?.live_version ?? 'unknown', to: now };
    liveVersion = now;
  }
} catch (err) {
  // Losing the live check must not lose the release check; keep the previous value so a
  // failed fetch is never reported as a version change.
  console.error(`agent.json unreadable: ${err.message}`);
}

mkdirSync(DATA, { recursive: true });
writeFileSync(STATE, JSON.stringify({
  checked_at: new Date().toISOString(),
  live_version: liveVersion,
  repos: [...seenRepos].sort(),
  releases: [...seenReleases].sort(),
}, null, 1) + '\n');

const count = news.releases.length + news.repos.length + (news.version ? 1 : 0);
console.log(first
  ? `seeded: ${seenRepos.size} repos, ${seenReleases.size} releases, live ${liveVersion}`
  : `${count} new: ${news.releases.length} releases, ${news.repos.length} repos` +
    (news.version ? `, live ${news.version.from} -> ${news.version.to}` : ''));

if (process.env.GITHUB_OUTPUT) {
  const lines = [];

  if (news.repos.length) {
    lines.push('## A new repository appeared in flop-labs', '',
      'This is the signal worth reading first — a testnet, a faucet or an inference',
      'API shows up here before it is written about anywhere.', '');
    for (const r of news.repos) {
      lines.push(`- **[${r.name}](${r.url})** — created ${r.created}`, `  ${r.description}`);
    }
    lines.push('');
  }

  if (news.version) {
    lines.push('## technocore.chat is serving a new version', '',
      `\`${news.version.from}\` → **\`${news.version.to}\`**`, '',
      'This is the deployment, not the tag. Check the protocol documents against',
      '`tc.mjs` and `GUIDE.ko.md` before trusting either.', '');
  }

  if (news.releases.length) {
    lines.push('## New releases', '');
    for (const r of news.releases) {
      lines.push(`### [${r.repo} ${r.name}](${r.url})`, '',
        `Published ${r.published}`, '');
      if (r.excerpt) lines.push(r.excerpt, '');
    }
  }

  writeFileSync(process.env.GITHUB_OUTPUT,
    `news=${count > 0}\n` +
    `headline=${news.version ? `technocore.chat ${news.version.to}` :
                news.repos.length ? `new repo: ${news.repos[0].name}` :
                news.releases.length ? `${news.releases[0].repo} ${news.releases[0].tag}` : ''}\n` +
    `summary<<RELEASES_EOF\n${lines.join('\n')}\nRELEASES_EOF\n`, { flag: 'a' });
}
