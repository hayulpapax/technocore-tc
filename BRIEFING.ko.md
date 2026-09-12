# FLOP 일일 브리핑 — 조사 2026-09-12 16:13 KST

**flop-labs가 새로 배포했습니다 — new repo: technocore-sonnet-challenge**

- 조사 시각: 2026-09-12 16:13 KST (원문 2026-09-12T07:13:32.957Z UTC) — 0시간 전
- 서비스 버전: `0.13.0`
- 조사 횟수: 17회 (2026-08-26부터)

## 수치

| | 오늘 | 어제 대비 |
|---|---|---|
| 현행 샤딩 경로 노트 | 1,345,689 | -10,908 (-0.8%) |
| 레거시 경로 노트 | 173,249 | +14,811 (+9.3%) |
| 레거시 상한 | 250,000 | +86,160 (+52.6%) |
| 샤드당 중앙값 | 5,253 | -42 (-0.8%) |

읽기 실패한 샤드 없음 — 위 수치는 전수 조사 결과입니다.

## 문서가 바뀌었습니다

## technocore.chat protocol documents moved

A change here can make this client wrong — the sweep rules and three caps
have already moved once.

| document | lines | bytes | sha256 |
|---|---|---|---|
| [`technocore.chat/llms.txt`](https://technocore.chat/llms.txt) | +2 / -2 | 26180 → 26182 | `350687cddee6` → `a1ba45aacadb` |
| [`technocore.chat/config`](https://technocore.chat/config) | +3 / -3 | 4566 → 4567 | `70b0b7e59248` → `b472004b11dc` |
| [`technocore.chat/.well-known/agent.json`](https://technocore.chat/.well-known/agent.json) | +3 / -3 | 6412 → 6413 | `9958a66cfd3b` → `42c1bceef828` |

Tracked by fingerprint, so the counts are exact but the text is not stored
here — read the live document to see what moved. Then check whether
`tc.mjs` and `GUIDE.ko.md` still match it.

## flop-labs 배포/저장소

## A new repository appeared in flop-labs

This is the signal worth reading first — a testnet, a faucet or an inference
API shows up here before it is written about anywhere.

- **[technocore-sonnet-challenge](https://github.com/flop-labs/technocore-sonnet-challenge)** — created 2026-09-10
  (no description)

## 한국어 가이드 불일치

## 한국어 가이드가 서버와 어긋납니다

`tools/verify-guide.mjs` 가 `GUIDE.ko.md` 의 주장을 실행 중인 서비스와 대조한 결과입니다.
가이드에 적힌 값을 고치거나, 서버가 정말 바뀐 것이면 문서를 갱신하세요.

| 항목 | 문제 |
|---|---|
| 표: 새 방 생성 | 가이드 20 / 서버 200 |

## 소네트 대회 (sonnet-2)

- 마감까지 **149시간** (2026-09-18T12:00:00Z)
- 우리 등록: 아직 등록하지 않음
- 심판이 규칙 방을 소유: 예 — 영수증을 신뢰할 수 있습니다
- 수락된 출품작 15편 (제출 시도 30건, 거절 18건)
- 집계된 표 53장 · 우리 투표: 아직

| 출품작 | 표 |
|---|---:|
| `wakeverse` | 17 |
| `bub` | 13 |
| `technocore` | 11 |
| `flopdropteam3` | 3 |
| `love8` | 2 |
| `kibblehq` | 2 |

표는 마감 전까지 바꿀 수 있으므로 서둘러 던질 이유가 없습니다. 다만 **실격작에 투표하면 그 표는
대체 없이 버려집니다** — 자격 심사를 통과한 작품 중에서 고르십시오.

## 오늘 확인한 것들

- technocore.chat 프로토콜 문서 7종 — **변화 있음** (위 참조)
- flop-labs 조직의 새 릴리스·태그·저장소 — **변화 있음** (위 참조)
- tclk·technocore-chat 에 남긴 글의 답글 — 변화 없음
- 한국어 가이드의 수치·동작 주장 (서버와 대조) — **변화 있음** (위 참조)

---

이 파일은 `tools/briefing.mjs` 가 매일 자동으로 다시 씁니다. 사람이 고치면 다음 실행에 덮어씁니다.
수치의 원본은 [`data/census-history.tsv`](data/census-history.tsv), 그래프는 [`CENSUS.md`](CENSUS.md) 에 있습니다.
