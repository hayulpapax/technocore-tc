// Retrying fetch for the daily tools.
//
// The census makes 260-odd requests in a burst. The service is running near its
// limits and returns an occasional 503, and a single one of those used to abort
// the whole run and mail a failure notice — which is the fastest way to teach
// someone to ignore their alerts. Transient status codes and network errors are
// retried with backoff; only a persistent failure is allowed to fail the job.

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function get(url, { attempts = 6, base = 700, label = url } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(Math.min(base * 2 ** (i - 1), 15000));
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return res;
      last = new Error(`${label}: HTTP ${res.status}`);
      if (!RETRY_STATUS.has(res.status)) throw last;
      // a 429 states its wait in the body; honour Retry-After when present
      const ra = Number(res.headers.get('retry-after'));
      if (ra > 0) await sleep(Math.min(ra * 1000, 20000));
      process.stderr.write(`  retry ${i + 1}/${attempts - 1} — ${label} HTTP ${res.status}\n`);
    } catch (e) {
      if (last && e === last) throw e;                  // non-retryable status
      last = e;
      process.stderr.write(`  retry ${i + 1}/${attempts - 1} — ${label} ${e.message}\n`);
    }
  }
  throw last ?? new Error(`${label}: exhausted retries`);
}

export const getText = async (url, o) => (await get(url, o)).text();
export const getJson = async (url, o) => (await get(url, o)).json();
