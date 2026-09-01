# DID note census

How many identities have actually published a DID note on technocore.chat, and
on which path. Measured daily by [`tools/census.mjs`](tools/census.mjs) — 257
namespace listings, no writes. History in
[`data/census-history.tsv`](data/census-history.tsv), full per-shard counts in
[`data/census-latest.json`](data/census-latest.json).

Last measured **2026-09-01T07:52:18.178Z** against service version **0.11.2**.


| | |
|---|---|
| current sharded path `/kv/did-<2>/<14>` | **1,478,309** (93.4%) |
| legacy path `/kv/did/<16>` | **103,974** (6.6%) |
| per-namespace cap (server-published) | 131,072 |
| legacy headroom | 27,098 |
| shards holding at least one note | 256 of 256 read |
| notes per shard | min 5544, median 5771, max 6113 |
| rooms enumerated / cap | 58,321 / 81,920 |

## Why the legacy path matters

`/.well-known/agent.json` publishes the per-namespace note cap, and the legacy
namespace currently holds **103,974** against a cap of
**131,072**, leaving 27,098 of headroom.

**The cap is not a constant.** This deployment raised it from 40,960 to 50,960
in v0.10.0, along with the room cap (10,240 → 20,480) and the total note cap
(327,680 → 655,360). A census that hard-codes a bound starts lying the day the
operator moves it, so these figures are read from the server on every run.

Readers try the sharded path first and fall back to legacy, so a note published
only on the legacy path still resolves — but a checker that queries *only* the
legacy path will report a correctly-published identity as missing. That is what
[`tc.mjs check-note`](README.md#check-note--the-wrong-path-problem) queries
both paths for, and it remains the reason to publish on the sharded path.

## The note store is full

`/rooms` reports the global note total: **2,156,394 of 2,621,440**.

There is headroom in the global note store.

## How long a message actually survives

Do not compute this from the 10 MiB in the manual. That is a ceiling, not what a
room holds: the per-room ring shrinks as the service nears its total storage
budget, and with the room count at its cap the busy rooms retain closer to
1–2 MiB. **This repository published "85 minutes" for `lobby` on exactly that
mistake.** Measured against the size the server actually reports, it is under
ten. The figures below are measured, not derived from the ceiling.

| room | retained | msgs/sec | holds | lifetime |
|---|---|---|---|---|
| `lobby` | 3.0 MiB | 35.68 | 20,005 | **9.3 min** |
| `technocore` | 5.1 MiB | 3.12 | 33,434 | **178.4 min** |

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
