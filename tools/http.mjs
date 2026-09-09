// Retrying fetch for the daily tools.
//
// The census makes 260-odd requests in a burst. The service is running near its
// limits and returns an occasional 503, and a single one of those used to abort
// the whole run and mail a failure notice — which is the fastest way to teach
// someone to ignore their alerts. Transient status codes and network errors are
// retried with backoff; only a persistent failure is allowed to fail the job.

// 520-527 are Cloudflare's own: the edge answered but the origin did not, or not
// in time. technocore sits behind Cloudflare, and a large /export reliably draws a
// 524 (origin timeout) that the standard 5xx list misses entirely — it failed a
// run here before this line existed.
const RETRY_STATUS = new Set([
  408, 429, 500, 502, 503, 504,
  520, 521, 522, 523, 524, 525, 526, 527,
]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// fetch has no default timeout, so a connection that opens and then says nothing hangs
// until the job's own limit — six hours on a GitHub runner, for a census that takes two
// minutes. Verified against a server that accepts and never answers: without this the
// call never returns. Generous rather than tight, because /export is megabytes and a slow
// transfer is not a hung one; a timeout lands in the catch below and is retried like any
// other network error.
const TIMEOUT_MS = Number(process.env.TC_HTTP_TIMEOUT_MS) || 60_000;

export async function get(url, { attempts = 6, base = 700, label = url, headers,
                                 timeout = TIMEOUT_MS } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(Math.min(base * 2 ** (i - 1), 15000));
    try {
      const res = await fetch(url, {
        ...(headers ? { headers } : {}),
        signal: AbortSignal.timeout(timeout),
      });
      if (res.ok || res.status === 404) return res;
      last = new Error(`${label}: HTTP ${res.status}`);
      if (!RETRY_STATUS.has(res.status)) throw last;
      // a 429 states its wait in the body; honour Retry-After when present
      const ra = Number(res.headers.get('retry-after'));
      if (ra > 0) await sleep(Math.min(ra * 1000, 20000));
      // Say a retry is coming only when one is. The last attempt used to log
      // "retry 6/5" and then throw, which reads as a seventh try that never happened.
      if (i < attempts - 1) process.stderr.write(`  retry ${i + 1}/${attempts - 1} — ${label} HTTP ${res.status}\n`);
    } catch (e) {
      if (last && e === last) throw e;                  // non-retryable status
      last = e;
      if (i < attempts - 1) process.stderr.write(`  retry ${i + 1}/${attempts - 1} — ${label} ${e.message}\n`);
    }
  }
  throw last ?? new Error(`${label}: exhausted retries`);
}

export const getText = async (url, o) => (await get(url, o)).text();

// `get` returns a 404 rather than throwing, so callers can tell absent from broken. That
// leaves getJson parsing a body that is not JSON, and the caller sees
// `SyntaxError: Unexpected token 'o', "no such room" is not valid JSON` — an error about
// the wrong thing entirely. technocore answers a missing room with an empty 200 rather
// than a 404, so this is a sharp edge rather than a live crash, but the next caller to
// ask for JSON at a path that can be absent deserves to be told which it was.
export const getJson = async (url, o) => {
  const res = await get(url, o);
  if (res.status === 404) throw new Error(`${o?.label ?? url}: 404 — no JSON to parse`);
  return res.json();
};
