# FLOP 일일 브리핑 — 조사 2026-09-10 16:23 KST

**flop.finance 페이지가 바뀌었습니다 — 테스트넷·faucet·에어드랍이 올라오는 곳입니다**

- 조사 시각: 2026-09-10 16:23 KST (원문 2026-09-10T07:23:11.918Z UTC) — 0시간 전
- 서비스 버전: `0.13.0`
- 조사 횟수: 15회 (2026-08-26부터)

## 수치

| | 오늘 | 어제 대비 |
|---|---|---|
| 현행 샤딩 경로 노트 | 1,542,637 | +410 (+0.0%) |
| 레거시 경로 노트 | 163,726 | +532 (+0.3%) |
| 레거시 상한 | 163,840 | 변화 없음 |
| 샤드당 중앙값 | 6,027 | +7 (+0.1%) |

읽기 실패한 샤드 없음 — 위 수치는 전수 조사 결과입니다.

## 문서가 바뀌었습니다

## flop.finance moved

This is the group worth reading first. The testnet, the faucet and the
tokenomics are published here, and this is the announcement being waited on.

| document | lines | bytes | sha256 |
|---|---|---|---|
| [`flop.finance/teaser/`](https://flop.finance/teaser/) | +1 / -1 | 49826 → 49817 | `8d4e3de68175` → `032f0489d177` |

Tracked by fingerprint, so the counts are exact but the text is not stored
here — read the live document to see what moved. Then check whether
`tc.mjs` and `GUIDE.ko.md` still match it.

## flop-labs 배포/저장소

## A new repository appeared in flop-labs

This is the signal worth reading first — a testnet, a faucet or an inference
API shows up here before it is written about anywhere.

- **[yellowpaper](https://github.com/flop-labs/yellowpaper)** — created 2026-09-04
  FLOP Network yellowpaper — normative specification for a verified-inference settlement layer. Feedback via Issues.

## 오늘 확인한 것들

- technocore.chat 프로토콜 문서 7종 — **변화 있음** (위 참조)
- flop-labs 조직의 새 릴리스·태그·저장소 — **변화 있음** (위 참조)
- tclk·technocore-chat 에 남긴 글의 답글 — 변화 없음
- 한국어 가이드의 수치·동작 주장 (서버와 대조) — 변화 없음

---

이 파일은 `tools/briefing.mjs` 가 매일 자동으로 다시 씁니다. 사람이 고치면 다음 실행에 덮어씁니다.
수치의 원본은 [`data/census-history.tsv`](data/census-history.tsv), 그래프는 [`CENSUS.md`](CENSUS.md) 에 있습니다.
