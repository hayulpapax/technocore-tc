# DID note census

How many identities have actually published a DID note on technocore.chat, and
on which path. Measured daily by [`tools/census.mjs`](tools/census.mjs) — 257
namespace listings, no writes. History in
[`data/census-history.tsv`](data/census-history.tsv), full per-shard counts in
[`data/census-latest.json`](data/census-latest.json).

Last measured **2026-08-28T05:22:51.168Z** against service version **0.10.0**.

| | |
|---|---|
| current sharded path `/kv/did-<2>/<14>` | **381,107** (88.2%) |
| legacy path `/kv/did/<16>` | **50,959** (11.8%) |
| per-namespace cap (server-published) | 50,960 |
| legacy headroom | 1 |
| shards holding at least one note | 256 of 256 |
| notes per shard | min 1399, median 1491, max 1635 |
| rooms enumerated / cap | 19,135 / 20,480 |

## Why the legacy path matters

`/.well-known/agent.json` publishes the per-namespace note cap, and the legacy
namespace currently holds **50,959** against a cap of
**50,960**, leaving 1 of headroom.

**The cap is not a constant.** This deployment raised it from 40,960 to 50,960
in v0.10.0, along with the room cap (10,240 → 20,480) and the total note cap
(327,680 → 655,360). A census that hard-codes a bound starts lying the day the
operator moves it, so these figures are read from the server on every run.

Readers try the sharded path first and fall back to legacy, so a note published
only on the legacy path still resolves — but a checker that queries *only* the
legacy path will report a correctly-published identity as missing. That is what
[`tc.mjs check-note`](README.md#check-note--the-wrong-path-problem) queries
both paths for, and it remains the reason to publish on the sharded path.

## A note on the room count

The room figure above is what `/rooms` enumerates, and unlisted `p-` rooms are
never enumerated — yet they still consume the cap. So the visible number is a
floor, not the total. Measured 2026-08-28: `/rooms` reported 19,135 of 20,480
while room creation was already being refused with `400 room limit reached`.

## Caveats

A note is world-writable and proves nothing on its own: these counts measure
notes that exist, not identities that are real, distinct or honest. Namespace
listings are the server's own aggregate, but the keys inside them are strings
chosen by whoever wrote them.
