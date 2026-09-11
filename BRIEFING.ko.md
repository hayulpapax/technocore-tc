# FLOP 일일 브리핑 — 조사 2026-09-11 16:22 KST

**flop.finance 페이지가 바뀌었습니다 — 테스트넷·faucet·에어드랍이 올라오는 곳입니다**

- 조사 시각: 2026-09-11 16:22 KST (원문 2026-09-11T07:22:01.908Z UTC) — 0시간 전
- 서비스 버전: `0.13.0`
- 조사 횟수: 16회 (2026-08-26부터)

## 수치

| | 오늘 | 어제 대비 |
|---|---|---|
| 현행 샤딩 경로 노트 | 1,356,597 | -186,040 (-12.1%) |
| 레거시 경로 노트 | 158,438 | -5,288 (-3.2%) |
| 레거시 상한 | 163,840 | 변화 없음 |
| 샤드당 중앙값 | 5,295 | -732 (-12.1%) |

읽기 실패한 샤드 없음 — 위 수치는 전수 조사 결과입니다.

## 하루 만에 크게 줄었습니다

노트 수가 1,542,637 → 1,356,597 로 186,040개 감소했습니다. 샤드당 중앙값도 6,027 → 5,295 로 같이 움직였으므로, 일부 샤드만의 문제가 아니라 전체에 걸친 변화입니다.

노트는 7일간 쓰기가 없으면 삭제됩니다(`retention_seconds: 604800`). 7일 전에 크게 늘었다면 그 물결이 만료된 것과 일치합니다 — 다만 서버가 그렇게 공지한 것은 아니므로 단정하지는 마십시오.

## 문서가 바뀌었습니다

## flop.finance moved

This is the group worth reading first. The testnet, the faucet and the
tokenomics are published here, and this is the announcement being waited on.

| document | lines | bytes | sha256 |
|---|---|---|---|
| [`flop.finance/teaser/`](https://flop.finance/teaser/) | +14 / -14 | 49817 → 49834 | `032f0489d177` → `17799a2a21f4` |

Tracked by fingerprint, so the counts are exact but the text is not stored
here — read the live document to see what moved. Then check whether
`tc.mjs` and `GUIDE.ko.md` still match it.

## flop-labs 배포/저장소

## A new repository appeared in flop-labs

This is the signal worth reading first — a testnet, a faucet or an inference
API shows up here before it is written about anywhere.

- **[technocore-sonnet-challange](https://github.com/flop-labs/technocore-sonnet-challange)** — created 2026-09-10
  (no description)

## 오늘 확인한 것들

- technocore.chat 프로토콜 문서 7종 — **변화 있음** (위 참조)
- flop-labs 조직의 새 릴리스·태그·저장소 — **변화 있음** (위 참조)
- tclk·technocore-chat 에 남긴 글의 답글 — 변화 없음
- 한국어 가이드의 수치·동작 주장 (서버와 대조) — 변화 없음

---

이 파일은 `tools/briefing.mjs` 가 매일 자동으로 다시 씁니다. 사람이 고치면 다음 실행에 덮어씁니다.
수치의 원본은 [`data/census-history.tsv`](data/census-history.tsv), 그래프는 [`CENSUS.md`](CENSUS.md) 에 있습니다.
