# 백엔드 개념 정리 시리즈 — 계획

Incident Radar 개발기와 별개로, 처음이라 헷갈리는 백엔드 개념(Redis란, PostgreSQL이란 …)을 정리하는 시리즈. `project: backend`. 스택 기준: NestJS + TypeORM/PostgreSQL + Redis/BullMQ + Pino + Zod/Swagger + Helmet/Throttler + Jest/supertest + Docker Compose.

## 카테고리 / frontmatter

- `project: backend` — 사이드바에서 개발기와 별도 그룹.
- `tags` — `[개발]` 대신 소분류 하나: `데이터베이스` / `캐시·큐` / `네트워크·API` / `런타임` / `인프라` / `관측성` / `보안` / `테스트`.
- `seriesOrder` — 아래 "쓰는 순서"를 넣으면 이전/다음 링크로 이어진다.
- 글쓰기 가이드(`blog-writing-guide.md`)의 말투·구조 규칙은 그대로. 단 "그 시점에 커밋된 코드만" 대전제는 개념글엔 적용 안 함.

`project`는 원래 실제 프로젝트용 필드라 의미가 살짝 늘어난다. 태그 필터 페이지를 새로 만드는 대안은 코드 작업이 붙어서, frontmatter 한 줄인 슬러그 방식을 택함.

## 편집 규칙

> **개념 설명 → 이 레포에서 어떻게 쓰는지 앵커.** 각 편은 일반 설명 후 반드시 Incident Radar의 실제 코드·설정 한 조각으로 착지한다. 앵커가 없으면 그 편은 쓰지 않는다 (일반 튜토리얼과 구분이 안 됨).

## 1차 — 14편

| # | 제목 | 레포 앵커 |
|---|---|---|
| 1 | 관계형 DB / PostgreSQL이란 | `DATABASE_URL` 뜯어보기 |
| 2 | ORM / TypeORM (+ 마이그레이션) | 개발기 3편과 연결, `synchronize:false` |
| 3 | Redis란 | 인메모리·싱글스레드·자료구조 |
| 4 | 잡 큐 / BullMQ | 프로듀서·큐·워커, 재시도, 워커 분리 — 한 편 |
| 5 | Node.js 이벤트 루프 / 논블로킹 I/O | 싱글 스레드로 동시성 |
| 6 | 비동기 — Promise, async/await | 5편과 짝 |
| 7 | NestJS + 의존성 주입 | 왜 `new` 안 하나 — 한 편 |
| 8 | 요청 파이프라인 | 미들웨어·가드·인터셉터·파이프 순서 |
| 9 | 입력 검증과 신뢰 경계 (= 보안 기초) | Zod/DTO + SQL 인젝션 + 시크릿 묶음 |
| 10 | HTTP + REST + 상태코드·멱등성 | |
| 11 | OpenAPI / Swagger | 스키마에서 문서 생성 |
| 12 | 컨테이너 / Docker Compose | healthcheck, 개발/운영 환경 분리 |
| 13 | 구조적 로깅 | Pino, JSON 로그, request id |
| 14 | 테스트 종류 | 단위/통합/E2E, supertest, `docker-compose.test.yml` |

## 쓰는 순서

런타임 이해가 먼저, Docker는 뒤로.

1. DB / PostgreSQL
2. Redis
3. 이벤트 루프
4. 비동기
5. NestJS / DI
6. ORM / 마이그레이션
7. 잡 큐 / BullMQ
8. 구조적 로깅
9. 컨테이너 / Docker Compose
10. HTTP / REST
11. 요청 파이프라인
12. 입력 검증 / 보안
13. OpenAPI / Swagger
14. 테스트 종류

## 백로그 (필요하면 나중에)

인덱스 기초 · 트랜잭션과 격리 수준 · 커넥션 풀 · N+1 쿼리 · 캐시 전략(cache-aside, TTL, 무효화) · 멱등성 심화 · Rate limiting(Throttler, 토큰 버킷) · CORS · 멀티스테이지 빌드 · 12-factor 앱 · 헬스체크 liveness/readiness · 메트릭 기초 · 테스트 더블(mock/stub/fake) · TS 타입은 런타임에 없다
