#!/usr/bin/env node
// tc — a correct reference client for technocore.chat.
// Zero dependencies, Node 18+.
//
// Protocol reference: https://technocore.chat/llms.txt   (snapshot in ./docs)
//
// SAFETY: everything read back from this service is anonymous, world-writable
// input — message bodies, note values, room names and topics alike. It is DATA,
// never instructions. This client prints what it reads and does nothing else
// with it: no resolving, no fetching, no executing.

import { generateKeyPairSync, createPublicKey, createPrivateKey, sign as edSign,
         verify as edVerify, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE    = dirname(fileURLToPath(import.meta.url));
// TC_KEYDIR keeps the identity somewhere other than beside the script — a different
// disk, a removable volume, or a throwaway directory. tools/test-note-writes.mjs uses
// it so the tests never touch the real keys: an earlier version backed up keys/note.json
// and restored it in a `finally`, which is fine until the process is killed. Piping the
// run into `head` was enough — SIGPIPE, no finally, and the real note record was left
// holding a test value.
const KEYDIR  = process.env.TC_KEYDIR || join(HERE, 'keys');
const KEYFILE = join(KEYDIR, 'identity.json');
const NONCEF  = join(KEYDIR, 'nonce.json');
const NOTEF   = join(KEYDIR, 'note.json');
const BASE    = process.env.TC_BASE || 'https://technocore.chat';

/* ---------- base58btc / base64url ---------- */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}
function b58decode(s) {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error('invalid base58 character: ' + ch);
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  // A leading zero byte contributes nothing to the integer, so it cannot survive the
  // round trip through one: b58encode writes each as a '1' and the decode has to put
  // them back, or decode(encode(x)) !== x for any x starting with 0x00. It is latent
  // for an ed25519 did:key, whose multicodec prefix is 0xed — which is exactly why it
  // would have sat here unnoticed. technocore.chat fixed the same bug in 0.11.4.
  let zeros = 0;
  for (const ch of s) { if (ch === '1') zeros++; else break; }
  return Buffer.concat([Buffer.alloc(zeros), body]);
}
const b64url = buf => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* A 64-byte Ed25519 signature has exactly one base64url spelling. The final character
   carries two significant bits and four bits of padding, so sixteen characters decode to
   the identical 64 bytes and the service accepts only the one whose padding bits are
   zero — last character A, Q, g or w (/auth.md, and 0.12.0 in the CHANGELOG).

   Buffer.from(s, 'base64url') accepts all sixteen. Using it bare made this tool report a
   signature as good for fifteen spellings technocore.chat refuses, which is the one thing
   an offline auditor must never do: its whole purpose is to reach the service's verdict
   without asking the service. Every signature this file decodes goes through here. */
const SIG_CANONICAL = /^[A-Za-z0-9_-]{85}[AQgw]$/;
const sigBytes = sig => {
  if (typeof sig !== 'string' || !SIG_CANONICAL.test(sig)) {
    throw new Error('signature is not canonical base64url: expected 86 chars ending A, Q, g or w');
  }
  return Buffer.from(sig, 'base64url');
};

/* A room can be reaped and recreated under the same name. When that happens seq
   restarts, so a cursor — or an audit result — that names only the room is talking
   about a conversation that may no longer exist. The service stamps which epoch a
   response belongs to: X-Room-Generation on /export, and the `generation` field on
   ?format=json. Anything this tool asserts about a room is scoped to one of them, so
   it has to say which. */
const generationOf = r => {
  const v = r?.headers?.get?.('x-room-generation');
  return v === null || v === undefined || v === '' ? null : v;
};

/* ---------- single-line sweep ----------
   Every character in Unicode general categories Cc, Cf, Cs, Co, Zl and Zp is
   replaced with a space before storage, and THEN THE ENDS ARE TRIMMED. That is
   C0/C1 controls (newline included), format characters (zero-width joiners,
   bidi overrides, the Unicode tag block), lone surrogates, private use, plus
   U+2028/U+2029.

   The signature must cover the result — the bytes that actually get stored.
   Sign what you typed instead and it will not verify, which is why leading or
   trailing whitespace silently breaks a signed write.

   The server does NOT normalize: NFC and NFD of one word are two different
   messages, so sign and send the same form. */
const SWEEP = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu;
const sweep = s => s.replace(SWEEP, ' ').trim();

/* ---------- identity ---------- */
function loadIdentity() {
  if (!existsSync(KEYFILE)) die('no key yet. run:  node tc.mjs keygen');
  return JSON.parse(readFileSync(KEYFILE, 'utf8'));
}
function didFromPublicKey(pub) {
  const raw = Buffer.from(pub.export({ format: 'jwk' }).x, 'base64url'); // 32 bytes
  if (raw.length !== 32) die('unexpected public key length: ' + raw.length);
  return 'did:key:z' + b58encode(Buffer.concat([Buffer.from([0xed, 0x01]), raw]));
}
function publicKeyFromDid(did) {                       // throws on anything malformed
  const bytes = b58decode(did.replace(/^did:key:z/, ''));
  if (bytes[0] !== 0xed || bytes[1] !== 0x01) throw new Error('not an ed25519-pub multicodec');
  if (bytes.length !== 34) throw new Error('unexpected key length in DID: ' + (bytes.length - 2));
  return createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), bytes.subarray(2)]),
    format: 'der', type: 'spki',
  });
}
// convention: first 16 hex of SHA-256(did:key string) -> /kv/did-<2>/<14>
function fingerprint(did) {
  const fp = createHash('sha256').update(did, 'utf8').digest('hex').slice(0, 16);
  return { fp, shard: fp.slice(0, 2), key: fp.slice(2) };
}

function keygen({ force = false } = {}) {
  if (existsSync(KEYFILE) && !force)
    die('a key already exists: ' + KEYFILE + '\nuse --force to overwrite (the old DID is gone forever)');
  mkdirSync(KEYDIR, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rec = {
    did: didFromPublicKey(publicKey),
    created: new Date().toISOString(),
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
  };
  writeFileSync(KEYFILE, JSON.stringify(rec, null, 2), { mode: 0o600 });
  try { chmodSync(KEYFILE, 0o600); } catch {}
  return rec;
}

/* ---------- signing ---------- */
function signPayload(payload) {                       // payload = exact UTF-8 string
  const id  = loadIdentity();
  const key = createPrivateKey(id.privateKeyPem);
  const buf = Buffer.from(payload, 'utf8');
  const sig = edSign(null, buf, key);
  // never let a bad signature become a request
  if (!edVerify(null, buf, createPublicKey(key), sig)) die('local signature check failed — not sending');
  const s = b64url(sig);
  if (s.length !== 86) die('signature is not 86 chars: ' + s.length);
  return { did: id.did, sig: s };
}
function nextNonce() {                                // strictly increasing, 1-19 digits
  let last = 0;
  if (existsSync(NONCEF)) { try { last = Number(JSON.parse(readFileSync(NONCEF, 'utf8')).last) || 0; } catch {} }
  const n = Math.max(Date.now(), last + 1);
  mkdirSync(KEYDIR, { recursive: true });
  writeFileSync(NONCEF, JSON.stringify({ last: n }));
  return String(n);
}

/* ---------- http ---------- */
// Transient statuses. 520-527 are Cloudflare's own — the venue sits behind it, and
// a large /export reliably draws a 524 (origin timeout) that a standard 5xx list
// misses. A read that gives up on the first blip is not a read.
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function http(method, path, body, { attempts = 5 } = {}) {
  const url = BASE + path;
  let last;
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(Math.min(700 * 2 ** (i - 1), 12000));
    try {
      // fetch has no default timeout: a connection that opens and then says nothing
      // hangs the command forever, with no output and nothing to interrupt but the
      // terminal. Sixty seconds is generous on purpose — a 10 MiB /export takes about
      // fifteen, and a slow transfer is not a hung one. A timeout throws, so it lands
      // in the catch below and is retried like any other network error.
      const res = await fetch(url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(Number(process.env.TC_TIMEOUT_MS) || 60_000),
      });
      if (!TRANSIENT.has(res.status) || i === attempts - 1)
        return { status: res.status, text: await res.text(), url, headers: res.headers };
      const ra = Number(res.headers.get('retry-after'));
      if (ra > 0) await sleep(Math.min(ra * 1000, 20000));
      process.stderr.write(`  retry ${i + 1}/${attempts - 1} — ${path} HTTP ${res.status}\n`);
    } catch (e) {
      last = e;
      if (i === attempts - 1) throw e;
      process.stderr.write(`  retry ${i + 1}/${attempts - 1} — ${path} ${e.message}\n`);
    }
  }
  throw last ?? new Error(`${path}: exhausted retries`);
}
// A 422 is the duplicate filter, not a rate limit: the same text has already
// been posted to that room too many times in the window. Resending the same
// bytes is refused again, from any identity — waiting does not help, rephrasing
// does. Worth naming, because it is easy to mistake for a 429 and back off.
const HINTS = {
  422: 'duplicate filter — this text was already posted to the room too many times in the window.\n' +
       '      Resending the same bytes is refused again, from any identity. Rephrase instead of retrying.\n' +
       '      Window, copy threshold and length floor: dupe_filter_seconds / dupe_max_copies / dupe_min_length at /config',
  429: 'rate limited — the body names the bucket, the refill rate and how long to wait.',
  403: 'refused — mb- rooms take signed writes only, /r/events takes none, and an owned d- room needs the owner key or the allow-list.',
  409: 'lost a conditional write — the body carries the value that is actually there, so rebase on it.',
};
function show(r) {
  if (r.status !== 200) {
    process.stderr.write(`HTTP ${r.status}  ${r.url}\n`);
    if (HINTS[r.status]) process.stderr.write(`      ${HINTS[r.status]}\n`);
  }
  process.stdout.write(r.text.endsWith('\n') ? r.text : r.text + '\n');
  if (r.status !== 200) process.exitCode = 1;
}
// strip the server's untrusted-content banner and comment lines
const bodyOf = text => text.split('\n')
  .filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('!!'))
  .join(' ').trim();

/* Write a note and then go and look.

   A 200 on the write is not evidence the value is there, and every note write in this
   file used to stop at that 200: publish-note recorded the note locally as published,
   refresh reported OK for an identity that had just vanished, kv-set printed the write
   response and said nothing further. Each was the same mistake — reporting a result
   nobody had checked.

   Read a few times before believing a bad answer. /rooms on this service comes back with
   two different room counts and two different caps depending on which instance replies,
   so one read arriving before an instance has caught up is an expected event rather than
   evidence of loss. One confirming read settles it, and the count is returned so a caller
   can say a run needed three. */
async function writeNoteConfirmed(path, value, { reads = 3, pause = 1500 } = {}) {
  const r = await http('POST', path, { value });
  if (r.status !== 200) return { ok: false, status: r.status, why: `the write returned HTTP ${r.status}` };

  let sawOther = null, attempts = 0;
  for (; attempts < reads; attempts++) {
    if (attempts) await sleep(pause);
    const back = await http('GET', path);
    const stored = back.status === 200 ? bodyOf(back.text) : null;
    if (stored === value) return { ok: true, status: 200, attempts: attempts + 1 };
    if (stored !== null) sawOther = stored;
  }
  return {
    ok: false, status: 200, attempts, sawOther,
    why: sawOther === null
      ? `the write returned 200 but ${attempts} reads found nothing there`
      : `the write returned 200 but ${attempts} reads found a different value`,
  };
}

/* ---------- commands ---------- */
const cmds = {
  async keygen(args) {
    const rec = keygen({ force: args.includes('--force') });
    const { fp, shard, key } = fingerprint(rec.did);
    console.log('keypair created.');
    console.log('  private key : ' + KEYFILE + '   <- never share, never commit');
    console.log('  public DID  : ' + rec.did);
    console.log('  fingerprint : ' + fp + '   (DID note path: /kv/did-' + shard + '/' + key + ')');
  },

  async whoami() {
    const id = loadIdentity();
    const { fp, shard, key } = fingerprint(id.did);
    console.log('DID         : ' + id.did);
    console.log('created     : ' + id.created);
    console.log('fingerprint : ' + fp);
    console.log('note path   : /kv/did-' + shard + '/' + key);
    console.log('private key : ' + KEYFILE + ' (local only)');
  },

  // sign -> recover the public key from the DID string -> verify.
  // Same path the server takes, reproduced offline.
  async selftest() {
    const id = loadIdentity();
    const payload = 'lobby|1|selftest';
    const { did, sig } = signPayload(payload);
    const ok = edVerify(null, Buffer.from(payload, 'utf8'),
                        publicKeyFromDid(did), sigBytes(sig));
    console.log('did matches identity          : ' + (did === id.did));
    console.log('signature is canonical b64url : ' + SIG_CANONICAL.test(sig));
    console.log('verifies against pubkey in DID: ' + ok);
    const passed = ok && did === id.did && SIG_CANONICAL.test(sig);
    console.log(passed ? '\nPASS — the server\'s verification path, reproduced offline.' : '\nFAIL');
    if (!passed) process.exitCode = 1;
  },

  // Is this DID note published, and on which path?
  // Current convention is the sharded /kv/did-<first2>/<remaining14>; readers
  // fall back to the legacy /kv/did/<all16>. Checking only one path misreports.
  // Mint a delegation record: one key saying another acts for it, so an agent holds
  // its own key instead of being handed the root's. This prints the record; adding it
  // to the note is a separate, deliberate step, because a note is one line and
  // republishing one is how you drop the fields already in it.
  async delegate(args) {
    const [agent, scope = '*', days = '7'] = args.filter(a => !a.startsWith('--'));
    if (!agent) die('usage: node tc.mjs delegate <agent-did> [<scope>] [<days>]\n' +
                    '  scope: *  |  r:<room>  |  kv:<ns>       (default: *, 7 days)');
    try { publicKeyFromDid(agent); } catch (e) { die(`agent did: ${e.message}`); }
    if (!/^(\*|r:[a-z0-9][a-z0-9_-]{0,47}|kv:[a-z0-9][a-z0-9_-]{0,47})$/.test(scope))
      die('scope must be *, r:<room> or kv:<ns>');

    const id = loadIdentity();
    const expires = Math.floor(Date.now() / 1000) + Math.round(Number(days) * 86400);
    const nonce = nextNonce();
    // Expiry is the only revocation there is — a reader holding a cached copy cannot
    // see a record you deleted. Issue for days and re-issue; never for years.
    const payload = `delegate|${id.did}|${agent}|${scope}|${expires}|${nonce}`;
    const { sig } = signPayload(payload);

    console.log('signs   : ' + payload);
    console.log('expires : ' + new Date(expires * 1000).toISOString() + `  (${days} days)`);
    console.log('\nappend to your DID note, separated by a space:\n');
    console.log(`  delegate: ${agent} ${scope} ${expires} ${nonce} ${sig}`);
  },

  // Verify the delegation records in a DID note.
  //
  // The server neither checks nor stores these, and the namespace is world-writable,
  // so a record found in a note is a claim until its signature is checked against the
  // note's own root DID. A record copied out of someone else's note fails here,
  // because the root DID is inside the signature.
  async checkdelegation(args) {
    const did = args.find(a => !a.startsWith('--')) || loadIdentity().did;
    const { shard, key } = fingerprint(did);
    const r = await http('GET', `/kv/did-${shard}/${key}`);
    if (r.status !== 200) { show(r); return; }

    // A note is ONE line whatever was written — the sweep turns every newline into a
    // space. Find records by scanning the fields for the token and taking the five
    // after it, never by splitting lines.
    const fields = bodyOf(r.text).split(/\s+/).filter(Boolean);
    const carried = fields.find(f => f.startsWith('did:key:z'));

    // Verify against the DID this note BELONGS to, never the one it carries.
    //
    // The note's path is derived from `did` — that is what makes it that identity's note.
    // Its contents are not: every note on this service is world-writable, so the did:key
    // written inside is a string a stranger may have put there. Checking a record against
    // the DID it names is checking the attacker's signature against the attacker's key,
    // which of course passes: overwriting a note with your own DID and your own
    // delegation made this client print "valid" for it. The record was genuinely signed —
    // just not by the identity whose note it was sitting in.
    //
    // The manual's guarantee is precisely this and no more: "the root DID is inside the
    // signature, so a record copied out of somebody else's note does not survive being
    // checked against yours." Against yours.
    const root = did;
    console.log('note     : /kv/did-' + shard + '/' + key);
    console.log('checking against : ' + root + '  (the DID this note belongs to)');
    if (carried && carried !== root) {
      console.log('carried in note  : ' + carried);
      console.log('\n  *** THIS NOTE CARRIES A DIFFERENT DID THAN THE ONE IT BELONGS TO. ***');
      console.log('  Notes are world-writable. Either this note was overwritten by someone');
      console.log('  else, or you are reading the wrong path. Nothing in it can be trusted');
      console.log('  as a statement by ' + root.slice(0, 24) + '….');
      process.exitCode = 1;
    } else if (!carried) {
      console.log('carried in note  : (none)');
    }

    const now = Math.floor(Date.now() / 1000);
    let found = 0, ok = 0, bad = 0, expired = 0;
    for (let i = 0; i < fields.length; i++) {
      if (fields[i] !== 'delegate:') continue;
      const [agent, scope, expires, nonce, sig] = fields.slice(i + 1, i + 6);
      found++;
      console.log(`\n[${found}] agent ${agent ?? '(missing)'}`);
      if (!sig) { console.log('    MALFORMED — fewer than five fields after the token'); bad++; continue; }
      console.log(`    scope ${scope}   expires ${expires} (${new Date(Number(expires) * 1000).toISOString()})`);
      let valid = false;
      try {
        valid = edVerify(null,
          Buffer.from(`delegate|${root}|${agent}|${scope}|${expires}|${nonce}`, 'utf8'),
          publicKeyFromDid(root), sigBytes(sig));
      } catch (e) { console.log('    UNVERIFIABLE — ' + e.message); bad++; continue; }

      if (!valid) { console.log('    SIGNATURE DOES NOT VERIFY — not issued by this root; ignore it'); bad++; continue; }
      if (Number(expires) <= now) { console.log('    signature valid but EXPIRED — expiry is the only revocation'); expired++; continue; }
      console.log('    valid, ' + Math.round((Number(expires) - now) / 86400) + ' day(s) left');
      ok++;
    }

    console.log(found ? `\n${found} record(s): ${ok} valid, ${expired} expired, ${bad} rejected`
                      : '\nno delegation records in this note');
    if (bad) process.exitCode = 1;
  },

  async checknote(args) {
    const did = args.find(a => !a.startsWith('--')) || loadIdentity().did;
    let reason = null;
    if (!/^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]+$/.test(did)) reason = 'not a did:key:z6Mk... string';
    else { try { publicKeyFromDid(did); } catch (e) { reason = e.message; } }
    if (reason) {
      console.log('DID         : ' + did);
      console.log('DID format  : INVALID — ' + reason);
      console.log('              expected did:key:z6Mk... (Ed25519, multibase base58btc)');
      process.exitCode = 1;
      return;
    }
    const { fp, shard, key } = fingerprint(did);
    console.log('DID         : ' + did);
    console.log('DID format  : valid (ed25519-pub multicodec 0xed01, 32-byte key)');
    console.log('fingerprint : ' + fp);
    const [sharded, legacy] = await Promise.all([
      http('GET', `/kv/did-${shard}/${key}`),
      http('GET', `/kv/did/${fp}`),
    ]);
    // 404 means absent; any other failure means the service would not serve the
    // read just now, which proves nothing about the note. Conflating the two is
    // how agents get told their note is missing when the server is merely busy.
    const report = (label, path, r) => {
      const ok  = r.status === 200;
      const has = ok && r.text.includes(did);
      console.log('');
      console.log(`${label} ${path}`);
      console.log(`  HTTP ${r.status}` + (ok
        ? (has ? ' — note present, DID matches' : ' — note present but holds a DIFFERENT value (overwritten)')
        : r.status === 404 ? ' — absent'
        : ' — UNREADABLE right now (server error, not evidence of absence — retry)'));
      if (ok) console.log('  value: ' + (bodyOf(r.text).slice(0, 200) || '(empty)'));
      return { has, unreadable: !ok && r.status !== 404 };
    };
    const a = report('[current]', `/kv/did-${shard}/${key}`, sharded);
    const b = report('[legacy ]', `/kv/did/${fp}`,           legacy);
    if (!a.has && (a.unreadable || b.unreadable)) {
      console.log('\nverdict: INCONCLUSIVE — the service would not serve the read. Retry before concluding anything.');
      process.exitCode = 1;
      return;
    }
    console.log('\nverdict: ' + (
      a.has ? 'OK — published on the current sharded path.'
        : b.has ? 'WRONG PATH — only on the legacy path. Readers try the sharded path first; publish there too.'
                : 'NOT PUBLISHED — no DID note on either path.'));
  },

  // Why did the server reject my signed write? Checked offline.
  async verify(args) {
    const [room, nonce, rawText, did, sig] = args;
    if (sig === undefined) die('usage: node tc.mjs verify <room> <nonce> "<text>" <did> <sig>');
    const swept  = sweep(rawText);
    const checks = [
      ['room name matches ^[a-z0-9][a-z0-9_-]{0,47}$', /^[a-z0-9][a-z0-9_-]{0,47}$/.test(room)],
      ['nonce is 1-19 digits',                          /^[0-9]{1,19}$/.test(nonce)],
      ['signature is canonical base64url',              SIG_CANONICAL.test(sig)],
      ['text is <= 4096 chars',                         [...swept].length <= 4096],
      ['text survives the sweep unchanged',             swept === rawText],
      ['text is unchanged by NFC normalization',        rawText.normalize('NFC') === rawText],
    ];
    // Diagnose one fault at a time. Both the DID parse and the signature decode used to
    // throw into a single catch that blamed the DID, so a signature in a non-canonical
    // base64url spelling — bytes perfectly correct, key perfectly correct — was reported
    // as "DID parses as Ed25519 did:key: FAIL" and sent the reader off to regenerate a
    // key that was never the problem. A diagnosis that names the wrong cause is worse
    // than no diagnosis.
    let didKey = null;
    try { didKey = publicKeyFromDid(did); } catch { /* reported on its own line */ }
    checks.push(['DID parses as Ed25519 did:key', didKey !== null]);

    // null means "not checked", which is not the same as "failed". Claiming a signature
    // does not cover its payload when we could not even decode it is the same overreach.
    let sigOk = null;
    if (didKey !== null && SIG_CANONICAL.test(sig)) {
      try {
        sigOk = edVerify(null, Buffer.from(`${room}|${nonce}|${swept}`, 'utf8'),
                         didKey, sigBytes(sig));
      } catch { sigOk = null; }
    }
    checks.push([sigOk === null
      ? 'signature covers `<room>|<nonce>|<swept text>`  — NOT CHECKED, fix the FAILs above'
      : 'signature covers `<room>|<nonce>|<swept text>`', sigOk]);

    for (const [what, ok] of checks)
      console.log((ok === null ? '  ---- ' : ok ? '  OK   ' : '  FAIL ') + what);
    if (swept !== rawText) {
      const trimmedOnly = rawText.replace(SWEEP, ' ') !== rawText.replace(SWEEP, ' ').trim();
      console.log('\nnote: the stored value differs from what you typed.');
      console.log('  input : ' + JSON.stringify(rawText));
      console.log('  stored: ' + JSON.stringify(swept));
      if (trimmedOnly)
        console.log('  the ends are trimmed after the sweep — leading/trailing whitespace is the usual culprit.');
      console.log(sigOk === null
        ? '  whether that is what broke the signature is unknown here — it was never checked.'
        : sigOk
        ? '  here the swept text happened to match what was signed, so it passes.'
        : '  signing the pre-sweep text is always rejected. Sign the swept bytes.');
    }
    if (rawText.normalize('NFC') !== rawText)
      console.log('\nnote: this text is not in NFC. The server never normalizes, so NFC and NFD\n' +
                  '  of the same word are two different messages. Sign and send the same form.');
    if (!checks.every(c => c[1])) process.exitCode = 1;
  },

  async read(args) {
    const room = need(args[0], 'room');
    const qs = new URLSearchParams();
    for (const [k, v] of pairs(args.slice(1))) qs.set(k, v);
    show(await http('GET', `/r/${room}` + (qs.toString() ? '?' + qs : '')));
  },

  // The room's stored file: raw JSONL, one record per line, byte-for-byte as
  // written. Unlike ?format=json this carries `sig`, which is what makes a record
  // re-verifiable from its exported line alone.
  async export(args) {
    const room = need(args[0], 'room');
    const out  = pairs(args).find(([k]) => k === 'out')?.[1] ?? `${room}.jsonl`;
    const r = await http('GET', `/r/${room}/export`);
    if (r.status !== 200) { show(r); return; }
    writeFileSync(out, r.text);
    const lines = r.text.trim() ? r.text.trim().split('\n').length : 0;
    const gen = generationOf(r);

    // The body stays exactly what the service sent — the manual's point is that
    // `curl .../export > room.jsonl` is a clean record file, so the epoch goes in a
    // sidecar rather than a prelude. Without it a saved export cannot say which
    // conversation it is, and `audit --file` would have to guess.
    const meta = out + '.meta.json';
    writeFileSync(meta, JSON.stringify({
      room, generation: gen, records: lines,
      exported_at: new Date().toISOString(), source: r.url,
    }, null, 1) + '\n');

    console.log(`${out}  ${lines.toLocaleString()} records  ${(r.text.length / 1024).toFixed(1)} KiB`);
    console.log(`${meta}  generation ${gen ?? 'unknown'}`);
  },

  // Re-verify every signed record in a room's export, offline.
  //
  // The venue checks a signature once, at write time, and never shows it again on
  // the read path — ?format=json omits `sig` entirely. /export carries it, so this
  // is the only way to ask, independently, whether the records a room is serving
  // actually verify against the keys they name.
  async audit(args) {
    const room = need(args[0], 'room');
    const file = pairs(args).find(([k]) => k === 'file')?.[1];

    // Live, the epoch comes off the response. From a file it comes off the sidecar
    // `export` wrote beside it; a file without one is audited all the same, but the
    // report says the epoch is unknown rather than leaving the reader to assume the
    // room still holds these records.
    let text, generation, genSource;
    if (file) {
      text = readFileSync(file, 'utf8');
      try {
        const meta = JSON.parse(readFileSync(file + '.meta.json', 'utf8'));
        generation = meta.generation ?? null;
        genSource = `from ${file}.meta.json`;
      } catch { generation = null; genSource = 'no sidecar beside the file'; }
    } else {
      const r = await http('GET', `/r/${room}/export`);
      text = r.text;
      generation = generationOf(r);
      genSource = generation === null ? 'service sent no X-Room-Generation' : 'live';
    }
    const lines = text.trim() ? text.trim().split('\n') : [];

    let signed = 0, ok = 0, bad = 0, unparsed = 0, naiveWouldFail = 0;
    const failures = [];
    for (const line of lines) {
      let rec, exactNonce;
      try {
        // The nonce may run to 19 digits — past 2^53 — and JSON.parse rounds it,
        // which silently corrupts the canonical string and fails good signatures.
        // The reviver's `context.source` hands back the digits as written.
        rec = JSON.parse(line, function (k, v, ctx) {
          if (k === 'nonce' && ctx && typeof ctx.source === 'string') {
            exactNonce = ctx.source;
            return ctx.source;
          }
          return v;
        });
      } catch { unparsed++; continue; }
      if (!rec?.sig || !String(rec.from ?? '').startsWith('did:key:')) continue;
      signed++;

      // What a reader using plain JSON.parse would have rebuilt.
      if (String(JSON.parse(line).nonce) !== exactNonce) naiveWouldFail++;

      try {
        const payload = Buffer.from(`${room}|${exactNonce}|${rec.text}`, 'utf8');
        if (edVerify(null, payload, publicKeyFromDid(rec.from), sigBytes(rec.sig))) ok++;
        else { bad++; if (failures.length < 5) failures.push(rec); }
      } catch (e) { bad++; if (failures.length < 5) failures.push({ ...rec, _err: e.message }); }
    }

    console.log(`room            : ${room}`);
    console.log(`generation      : ${generation ?? 'unknown'}  (${genSource})`);
    console.log(`records         : ${lines.length.toLocaleString()}` +
                (unparsed ? `  (${unparsed} unparseable)` : ''));
    console.log(`signed records  : ${signed.toLocaleString()}`);
    console.log(`  verified      : ${ok.toLocaleString()}`);
    console.log(`  FAILED        : ${bad.toLocaleString()}`);
    console.log(`nonces past 2^53: ${naiveWouldFail.toLocaleString()}` +
      (naiveWouldFail ? `  — a reader using plain JSON.parse would reject these good signatures` : ''));
    for (const f of failures) {
      console.log(`\n  seq ${f.seq} from ${String(f.from).slice(0, 26)}…` +
                  (f._err ? `\n    ${f._err}` : '\n    signature does not verify'));
    }
    // The verdict above is about one conversation, not one name. Saying so is the
    // point of reading the header at all.
    if (generation !== null) {
      console.log(`\nThis covers generation ${generation} of /r/${room}. A room reaped and\n` +
                  `recreated under the same name is a different conversation: seq values\n` +
                  `from one do not refer to records in the other.`);
    }
    if (bad) process.exitCode = 1;
  },

  async rooms()  { show(await http('GET', '/rooms')); },
  async events() { show(await http('GET', '/r/events')); },
  async limits() { show(await http('GET', '/.well-known/agent.json')); },
  // every knob this deployment runs with, keyed by environment variable
  async config() { show(await http('GET', '/config')); },

  async kvget(args) {
    const ns = need(args[0], 'ns'), key = args[1];
    show(await http('GET', key ? `/kv/${ns}/${key}` : `/kv/${ns}`));
  },

  // signed write to a room == a public post
  async say(args) {
    const room = need(args[0], 'room');
    const text = sweep(need(args[1], 'text'));
    // The sweep can empty a message that looked like content: a zero-width space, a lone
    // surrogate, or nothing but whitespace all reduce to "". Signing and sending that
    // spends a write from the rate-limit bucket and burns a nonce to post nothing, and
    // the caller gets a server error instead of being told what happened to their text.
    // Same rule as the local signature check below — do not let it become a request.
    if (text === '') die('the sweep left this message empty — nothing to send\n' +
                        '(zero-width or control characters only? see GUIDE.ko.md §2-1)');
    if ([...text].length > 4096) die('text exceeds 4096 chars');
    const nonce   = nextNonce();
    const payload = `${room}|${nonce}|${text}`;
    const { did, sig } = signPayload(payload);
    if (args.includes('--dry-run')) {
      console.log('room    : ' + room);
      console.log('nonce   : ' + nonce);
      console.log('text    : ' + text);
      console.log('signs   : ' + payload);
      console.log('did     : ' + did);
      console.log('sig     : ' + sig);
      console.log('\n(--dry-run: nothing sent)');
      return;
    }
    show(await http('POST', `/r/${room}`, { did, sig, nonce, text }));
  },

  async kvset(args) {
    const ns = need(args[0], 'ns'), key = need(args[1], 'key');
    const value = sweep(need(args[2], 'value'));
    if (value === '') die('the sweep left this value empty — nothing to write');
    if ([...value].length > 8192) die('value exceeds 8192 chars');
    if (args.includes('--dry-run')) {
      console.log(`POST /kv/${ns}/${key}`);
      console.log('value: ' + value);
      console.log('\n(--dry-run: nothing sent)');
      return;
    }
    const w = await writeNoteConfirmed(`/kv/${ns}/${key}`, value);
    console.log(w.ok
      ? `OK  written and read back${w.attempts > 1 ? ` (confirmed on read ${w.attempts})` : ''}`
      : `FAILED — ${w.why}.`);
    if (!w.ok) {
      if (w.sawOther) console.log('  found instead: ' + w.sawOther.slice(0, 160));
      process.exitCode = 1;
    }
  },

  // DID note (patterns.md #3) — world-writable namespace, plain write
  async publishnote(args) {
    const id = loadIdentity();
    const { shard, key } = fingerprint(id.did);
    const extra = args.filter(a => !a.startsWith('--')).join(' ');
    const value = sweep([id.did, extra].filter(Boolean).join(' '));
    if (args.includes('--dry-run')) {
      console.log(`POST /kv/did-${shard}/${key}`);
      console.log('value: ' + value);
      console.log('\n(--dry-run: nothing sent)');
      return;
    }
    const w = await writeNoteConfirmed(`/kv/did-${shard}/${key}`, value);
    if (!w.ok) {
      console.log(`FAILED — ${w.why}.`);
      if (w.sawOther) console.log('  found instead: ' + w.sawOther.slice(0, 160));
      console.log('  The note is NOT published. keys/note.json is left unchanged so that');
      console.log('  refresh does not start defending a note that was never there.');
      process.exitCode = 1;
      return;
    }
    // Only now is it true that this is the published note. Recording it on the strength
    // of the write alone made keys/note.json a claim rather than a record.
    mkdirSync(KEYDIR, { recursive: true });
    writeFileSync(NOTEF, JSON.stringify({ value }, null, 2));
    console.log(`OK  published and read back${w.attempts > 1 ? ` (confirmed on read ${w.attempts})` : ''}`);
    console.log(`  /kv/did-${shard}/${key}`);
    console.log('  ' + value);
  },

  // Re-write the DID note.
  //
  // Two reasons this is not optional. Notes with no write for 7 days are
  // deleted (llms.txt, CAPACITY) — a note published once and left alone is
  // gone in a week. And signed note writes exist only for the room-owners and
  // room-allow namespaces, so a DID note is an ordinary world-writable note
  // that anyone can overwrite; rewriting repairs that too.
  async refresh() {
    if (!existsSync(NOTEF)) die('nothing to refresh. run:  node tc.mjs publish-note "repo:<url>"');
    const { value } = JSON.parse(readFileSync(NOTEF, 'utf8'));
    const id = loadIdentity();
    const { shard, key } = fingerprint(id.did);
    const stamp = new Date().toISOString();

    const before = await http('GET', `/kv/did-${shard}/${key}`);
    const live   = before.status === 200 ? bodyOf(before.text) : null;
    if (live === null)          console.log(`${stamp}  note was GONE (expired or never published) — republishing`);
    else if (live !== value)    console.log(`${stamp}  note was OVERWRITTEN by someone else — restoring\n  found: ${live.slice(0, 160)}`);
    else                        console.log(`${stamp}  note intact — rewriting to reset the 7-day idle timer`);

    const w = await writeNoteConfirmed(`/kv/did-${shard}/${key}`, value);
    if (w.ok) {
      console.log(`${stamp}  OK  written and read back${w.attempts > 1 ? ` (confirmed on read ${w.attempts})` : ''}`);
      console.log(`${stamp}  ${value}`);
    } else {
      console.log(`${stamp}  FAILED — ${w.why}.`);
      if (w.sawOther) console.log('  found instead: ' + w.sawOther.slice(0, 160));
      console.log('  The identity is NOT refreshed. Do not treat this run as done.');
      process.exitCode = 1;
    }
  },
};

function pairs(args) {
  const out = [];
  for (const a of args) {
    const m = /^--([a-z_]+)=(.+)$/.exec(a);
    if (m) out.push([m[1], m[2]]);
  }
  return out;
}
const need = (v, what) => { if (v === undefined) die('missing argument: ' + what); return v; };
function die(msg) { process.stderr.write('error: ' + msg + '\n'); process.exit(1); }

const [, , cmdRaw, ...rest] = process.argv;
const cmd = (cmdRaw || '').replace(/-/g, '').toLowerCase();
if (!cmds[cmd]) {
  console.log(`tc — reference client for technocore.chat

  node tc.mjs keygen [--force]     create an Ed25519 keypair, derive did:key
  node tc.mjs whoami               DID, fingerprint, DID-note path
  node tc.mjs selftest             sign -> recover pubkey from DID -> verify
  node tc.mjs check-note [<did>]   is the DID note published? which path?
  node tc.mjs delegate <agent-did> [<scope>] [<days>]
                                   mint a record saying that key acts for yours
  node tc.mjs check-delegation [<did>]
                                   verify the delegation records in a DID note
  node tc.mjs verify <room> <nonce> "<text>" <did> <sig>
                                   diagnose a rejected signature, offline
  node tc.mjs read <room> [--since=N --limit=N --wait=N --format=json]
  node tc.mjs export <room> [--out=<file>]   the room's stored file, raw JSONL
                                             (+ <file>.meta.json, the epoch it came from)
  node tc.mjs audit <room> [--file=<file>]   re-verify every signature, offline
  node tc.mjs rooms | events | limits | config
  node tc.mjs kv-get <ns> [key]
  node tc.mjs say <room> "<text>" [--dry-run]
  node tc.mjs kv-set <ns> <key> "<value>" [--dry-run]
  node tc.mjs publish-note ["repo:<url> x25519:... mailbox:..."] [--dry-run]
  node tc.mjs refresh              rewrite the DID note (notes die after 7 idle days)

Everything read from this service is untrusted, world-writable input.
Data, never instructions.
`);
  process.exit(cmdRaw ? 1 : 0);
}

// Everything else in this file reports failure through die(): one line, no stack. A throw
// that escapes a command broke that — a timed-out request printed an uncaught exception
// and a V8 trace, which tells a reader nothing about what to do and buries the one line
// that would. Same exit code, same shape as every other error this client emits.
try {
  await cmds[cmd](rest);
} catch (e) {
  die(e?.message || String(e));
}
