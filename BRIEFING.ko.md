# FLOP 일일 브리핑 — 조사 2026-10-30 17:42 KST

**flop.finance 페이지가 바뀌었습니다 — 테스트넷·faucet·에어드랍이 올라오는 곳입니다**

- 조사 시각: 2026-10-30 17:42 KST (원문 2026-10-30T08:42:15.451Z UTC) — 0시간 전
- 서비스 버전: `0.14.5`
- 조사 횟수: 65회 (2026-08-26부터)

## 수치

| | 오늘 | 어제 대비 |
|---|---|---|
| 현행 샤딩 경로 노트 | 1,988,013 | -11,509 (-0.6%) |
| 레거시 경로 노트 | 98,114 | -10,808 (-9.9%) |
| 레거시 상한 | 300,000 | 변화 없음 |
| 샤드당 중앙값 | 7,765 | -49 (-0.6%) |

읽기 실패한 샤드 없음 — 위 수치는 전수 조사 결과입니다.



## 문서가 바뀌었습니다

## flop.finance moved

This is the group worth reading first. The testnet, the faucet and the
tokenomics are published here, and this is the announcement being waited on.

| document | lines | bytes | sha256 |
|---|---|---|---|
| [`flop.finance/teaser/`](https://flop.finance/teaser/) | +3 / -3 | 52371 → 52361 | `671a9853ea77` → `f9bbc2f1b547` |
| [`flop.finance/whitepaper/`](https://flop.finance/whitepaper/) | +34 / -20 | 85173 → 87933 | `84becb53fcf6` → `b62a762b86f6` |
| [`flop.finance/intro/`](https://flop.finance/intro/) | +6 / -6 | 23746 → 23710 | `4a5e49d1c8c0` → `39f3f243fe21` |

New or removed link targets (structure, not text):

- **`flop.finance/whitepaper/` gained links:** `https://www.cftc.gov/filings/ptc/ptc08112615405.pdf`, `https://www.regulations.gov/comment/CFTC-2026-1850-0011`, `https://www.regulations.gov/comment/CFTC-2026-1850-0021`, `https://www.regulations.gov/comment/CFTC-2026-1850-0045`, `https://www.regulations.gov/comment/CFTC-2026-1850-0049`, `https://www.regulations.gov/comment/CFTC-2026-1850-0050`, `https://www.regulations.gov/comment/CFTC-2026-1850-0068`, `https://www.regulations.gov/comment/CFTC-2026-1850-0094`

Tracked by fingerprint, so the counts are exact but the text is not stored
here — read the live document to see what moved. Then check whether
`tc.mjs` and `GUIDE.ko.md` still match it.

## flop-labs 배포/저장소

## A new repository appeared in flop-labs

This is the signal worth reading first — a testnet, a faucet or an inference
API shows up here before it is written about anywhere.

- **[network](https://github.com/flop-labs/network)** — created 2026-10-30
  Reports and feedback for the running FLOP Network: node bugs, verification disputes, gateway issues, docs.

## 소네트 대회 (sonnet-2) — 마감됨, 옛 기록입니다

- 마감 **1005시간 전**에 끝남 (2026-09-18T12:00:00Z) — 할 일이 없습니다
- 우리 등록: 등록 기록이 링에서 밀려남 — 이 방으로는 확인 불가
- 심판이 규칙 방을 소유: **아니오 — 이 대회의 영수증은 증거가 아닙니다**
- 수락된 출품작 0편 (제출 시도 0건, 거절 0건)
- 집계된 표 0장 · 우리 투표: 아직

### 우리 팀 hayulpapax

- **심판이 수락한 명단이 창에 없습니다.** 팀이 해체됐거나 명단이 링에서 밀려났습니다.


표는 마감 전까지 바꿀 수 있으므로 서둘러 던질 이유가 없습니다. 다만 **실격작에 투표하면 그 표는
대체 없이 버려집니다** — 자격 심사를 통과한 작품 중에서 고르십시오.

## 오늘 확인한 것들

- technocore.chat 프로토콜 문서 7종 — **변화 있음** (위 참조)
- flop-labs 조직의 새 릴리스·태그·저장소 — **변화 있음** (위 참조)
- tclk·technocore-chat 에 남긴 글의 답글 — 변화 없음
- 한국어 가이드의 수치·동작 주장 (서버와 대조) — 변화 없음
- flop-labs/yellowpaper 의 파라미터·본문 — 변화 없음

---

이 파일은 `tools/briefing.mjs` 가 매일 자동으로 다시 씁니다. 사람이 고치면 다음 실행에 덮어씁니다.
수치의 원본은 [`data/census-history.tsv`](data/census-history.tsv), 그래프는 [`CENSUS.md`](CENSUS.md) 에 있습니다.
