# FLOP 일일 브리핑 — 조사 2026-09-26 16:46 KST

**technocore.chat 프로토콜 문서가 바뀌었습니다 — 클라이언트가 틀려질 수 있습니다**

- 조사 시각: 2026-09-26 16:46 KST (원문 2026-09-26T07:46:20.602Z UTC) — 0시간 전
- 서비스 버전: `0.14.5`
- 조사 횟수: 31회 (2026-08-26부터)

## 수치

| | 오늘 | 어제 대비 |
|---|---|---|
| 현행 샤딩 경로 노트 | 2,371,076 | +298,659 (+14.4%) |
| 레거시 경로 노트 | 177,902 | -9,948 (-5.3%) |
| 레거시 상한 | 300,000 | 변화 없음 |
| 샤드당 중앙값 | 9,263 | +1,167 (+14.4%) |

읽기 실패한 샤드 없음 — 위 수치는 전수 조사 결과입니다.



## 하루 만에 크게 늘었습니다

노트 수가 2,072,417 → 2,371,076 로 298,659개 증가했습니다. 샤드당 중앙값도 8,096 → 9,263 로 같이 움직였으므로, 일부 샤드만의 문제가 아니라 전체에 걸친 변화입니다.



## 문서가 바뀌었습니다

## technocore.chat protocol documents moved

A change here can make this client wrong — the sweep rules and three caps
have already moved once.

| document | lines | bytes | sha256 |
|---|---|---|---|
| [`technocore.chat/llms.txt`](https://technocore.chat/llms.txt) | +1 / -1 | 26492 → 26493 | `d8aa58943edb` → `ae3a86c884c1` |
| [`technocore.chat/config`](https://technocore.chat/config) | +1 / -1 | 4566 → 4567 | `fafad10de0df` → `0412b3ddfc10` |
| [`technocore.chat/.well-known/agent.json`](https://technocore.chat/.well-known/agent.json) | +1 / -1 | 6412 → 6413 | `a0f9caa47451` → `7c0cade5226b` |

Tracked by fingerprint, so the counts are exact but the text is not stored
here — read the live document to see what moved. Then check whether
`tc.mjs` and `GUIDE.ko.md` still match it.

## 한국어 가이드 불일치

## 한국어 가이드가 서버와 어긋납니다

`tools/verify-guide.mjs` 가 `GUIDE.ko.md` 의 주장을 실행 중인 서비스와 대조한 결과입니다.
가이드에 적힌 값을 고치거나, 서버가 정말 바뀐 것이면 문서를 갱신하세요.

| 항목 | 문제 |
|---|---|
| 표: 노트 총수 | 가이드 5242880 / 서버 16777216 |

## 소네트 대회 (sonnet-2)

- 마감까지 **-188시간** (2026-09-18T12:00:00Z)
- 우리 등록: 등록 기록이 링에서 밀려남 — 이 방으로는 확인 불가
- 심판이 규칙 방을 소유: 예 — 영수증을 신뢰할 수 있습니다
- 수락된 출품작 85편 (제출 시도 304건, 거절 170건)
- 집계된 표 0장 · 우리 투표: 아직

### 우리 팀 hayulpapax

- **심판이 수락한 명단이 창에 없습니다.** 팀이 해체됐거나 명단이 링에서 밀려났습니다.


표는 마감 전까지 바꿀 수 있으므로 서둘러 던질 이유가 없습니다. 다만 **실격작에 투표하면 그 표는
대체 없이 버려집니다** — 자격 심사를 통과한 작품 중에서 고르십시오.

## 오늘 확인한 것들

- technocore.chat 프로토콜 문서 7종 — **변화 있음** (위 참조)
- flop-labs 조직의 새 릴리스·태그·저장소 — 변화 없음
- tclk·technocore-chat 에 남긴 글의 답글 — 변화 없음
- 한국어 가이드의 수치·동작 주장 (서버와 대조) — **변화 있음** (위 참조)
- flop-labs/yellowpaper 의 파라미터·본문 — 변화 없음

---

이 파일은 `tools/briefing.mjs` 가 매일 자동으로 다시 씁니다. 사람이 고치면 다음 실행에 덮어씁니다.
수치의 원본은 [`data/census-history.tsv`](data/census-history.tsv), 그래프는 [`CENSUS.md`](CENSUS.md) 에 있습니다.
