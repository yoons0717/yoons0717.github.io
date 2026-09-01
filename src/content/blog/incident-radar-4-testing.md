---
title: "[Incident Radar 4] 목 대신 진짜 Postgres·Redis에 붙여 테스트하기"
description: 카운터·cooldown·fallback은 Redis와 Postgres의 실제 동작이 검증 대상이라 목으로 대체하면 의미가 없다. 테스트 전용 인프라를 컨테이너로 올리고 격리하는 구성.
pubDate: 2026-09-01
tags: [개발]
seriesOrder: 4
---

3편에서는 DB 스키마를 마이그레이션으로 관리하는 방법을 정했습니다.

이제 실제 기능을 만들기 전에 테스트 전용 인프라를 구성합니다.

이 프로젝트에서 앞으로 구현할 슬라이딩 윈도우 카운터, cooldown, Redis 장애 시 fallback은 단순히 함수의 반환값만 확인해서는 충분하지 않습니다. Redis의 Sorted Set과 TTL, PostgreSQL의 실제 쿼리 동작 자체가 검증 대상이기 때문입니다.

그래서 Redis·Postgres의 동작에 직접 의존하는 테스트는 목(mock)으로 대체하지 않고, 테스트 전용 컨테이너에 실제 인프라를 올려 연결합니다.

## 테스트 전용 인프라

여기서 말하는 "테스트 전용"은 운영·스테이징처럼 별도의 배포 환경을 뜻하는 것이 아닙니다. **같은 노트북에서 개발용 Docker 스택과 테스트용 Docker 스택을 분리해 실행하는 구성**입니다.

`docker-compose.yml`은 `pnpm dev`로 앱을 개발할 때 사용하는 스택이고, `docker-compose.test.yml`은 `pnpm test`를 실행할 때만 올라갔다가 테스트가 끝나면 내려가는 스택입니다.

개발용 스택 하나로 자동 테스트까지 실행하면 문제가 생길 수 있습니다. 테스트가 매번 실행하는 `TRUNCATE` / `FLUSHDB` 때문에 개발하면서 사용하던 데이터가 지워질 수 있고, 반대로 개발 중 쌓인 데이터가 "행이 정확히 1개" 같은 테스트의 전제를 깨뜨릴 수도 있습니다.

그래서 테스트용 Postgres·Redis 스택을 별도로 올립니다.

개발용 스택과 동시에 실행해도 충돌하지 않도록 포트를 `5433` / `6380`으로 두고, `name`을 따로 지정해 Compose 프로젝트도 분리합니다.

Postgres의 데이터 디렉터리는 `tmpfs`로 RAM에 올립니다. 따라서 테스트 컨테이너를 내리면 DB 데이터도 남지 않습니다.

```yaml
name: incident-radar-test

services:
  postgres-test:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ir
      POSTGRES_PASSWORD: ir
      POSTGRES_DB: incident_radar
    ports: ["5433:5432"]
    tmpfs: ["/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ir -d incident_radar"]
      interval: 2s
      timeout: 3s
      retries: 20
  redis-test:
    image: redis:7-alpine
    ports: ["6380:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 3s
      retries: 20
```

개발용 스택과 테스트용 스택은 다음처럼 나뉩니다.

```text
개발용 스택 (docker-compose.yml, 볼륨)
  localhost:5432 → Postgres
  localhost:6379 → Redis

테스트용 스택 (docker-compose.test.yml, tmpfs)
  localhost:5433 → Postgres
  localhost:6380 → Redis
```

따라서 개발용 스택이 실행 중이어도 테스트용 스택을 별도로 올릴 수 있습니다.

## 테스트 환경변수

`.env.test`에는 테스트 전용 컨테이너의 접속 정보를 둡니다.

로컬 테스트 컨테이너에서만 사용하는 값이므로 이 프로젝트에서는 해당 파일을 커밋합니다.

```bash
# apps/backend/.env.test
NODE_ENV=test
DATABASE_URL=postgres://ir:ir@localhost:5433/incident_radar
REDIS_URL=redis://localhost:6380
ALERT_WINDOW_MS=60000
```

`test.mjs`가 이 파일을 파싱해 자식 프로세스의 환경변수로 주입합니다.

`data-source.ts`의 `dotenv`는 이미 존재하는 값을 덮어쓰지 않으므로, `test.mjs`에서 주입한 `5433` / `6380` 설정이 그대로 적용됩니다.

따라서 테스트에서는 개발용 `5432` / `6379`가 아니라 테스트 전용 `5433` / `6380`에 연결합니다.

## unit / e2e 분리

Jest의 `projects`로 테스트를 두 종류로 나눕니다.

* **unit** — `src` 안의 `*.spec.ts`. 함수 단위의 순수 로직부터 Redis·Postgres에 연결하는 서비스·리포지토리 테스트까지 이 프로젝트에 담을 계획입니다.
* **e2e** — `test` 안의 `*.e2e-spec.ts`. HTTP 요청부터 Controller, Service, Repository를 거쳐 실제 Redis·Postgres까지 연결되는 전체 흐름을 확인합니다.

이 편 시점에는 두 프로젝트 모두 거의 비어 있습니다. unit은 스펙이 아직 없어 `passWithNoTests: true`로 두고, e2e에는 아래 smoke 테스트 하나만 있습니다. 이후 기능을 만들면서 채워 나갑니다.

여기서 `unit`이라는 이름은 Jest 프로젝트를 구분하기 위한 것입니다. 실제 Redis·Postgres에 연결하는 테스트는 엄밀하게 말하면 integration test 성격에 가깝지만, 현재 프로젝트에서는 `src` 내부의 테스트를 하나의 Jest 프로젝트로 묶기 위해 `unit`이라는 이름을 사용했습니다.

둘 다 같은 테스트 전용 인프라에 연결하지만, 테스트 범위는 다릅니다.

```text
src/*.spec.ts
  Service / Repository → 실제 Redis·Postgres

test/*.e2e-spec.ts
  HTTP 요청 → Controller → Service → Repository → 실제 Redis·Postgres
```

```ts
// apps/backend/jest.config.ts
const config: Config = {
  passWithNoTests: true,
  watchman: false,
  projects: [
    {
      displayName: "unit",
      preset: "ts-jest",
      testEnvironment: "node",
      rootDir: "src",
      testMatch: ["**/*.spec.ts"],
      setupFilesAfterEnv: ["<rootDir>/../test/setup.ts"],
    },
    {
      displayName: "e2e",
      preset: "ts-jest",
      testEnvironment: "node",
      rootDir: ".",
      testMatch: ["<rootDir>/test/**/*.e2e-spec.ts"],
      setupFilesAfterEnv: ["<rootDir>/test/setup.ts"],
    },
  ],
};
```

## 테스트 간 격리

실제 DB와 Redis를 사용하는 만큼, 한 테스트가 남긴 데이터가 다음 테스트에 영향을 주지 않도록 격리해야 합니다.

각 테스트가 끝난 뒤 모든 엔티티 테이블을 `TRUNCATE ... RESTART IDENTITY CASCADE`로 비우고, Redis는 `FLUSHDB`로 초기화합니다.

```ts
// apps/backend/test/db.ts
export async function truncateAll(): Promise<void> {
  const tables = entities.map((e) => testDataSource.getMetadata(e).tableName);
  if (tables.length === 0) return;
  await testDataSource.query(
    `TRUNCATE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
}
```

`TRUNCATE`는 테이블의 데이터를 비우고, `RESTART IDENTITY`는 연결된 시퀀스를 초기화합니다.

`CASCADE`를 붙이면 외래 키 관계가 있는 테이블도 함께 처리할 수 있습니다.

테스트 lifecycle에서는 다음과 같이 초기화합니다.

```ts
// apps/backend/test/setup.ts
beforeAll(async () => {
  if (!testDataSource.isInitialized) {
    await testDataSource.initialize();
  }
});

afterEach(async () => {
  await truncateAll();
  await flushRedis();
});

afterAll(async () => {
  if (testDataSource.isInitialized) {
    await testDataSource.destroy();
  }
  redis.disconnect();
});
```

이렇게 하면 이전 테스트가 남긴 데이터에 다음 테스트가 영향을 받지 않습니다.

## 테스트를 한 번에 실행하기 — scripts/test.mjs

테스트를 실행할 때마다 직접 컨테이너를 올리고, 마이그레이션을 적용하고, 테스트가 끝난 뒤 다시 내리는 것은 번거롭습니다.

그래서 `pnpm test` 한 번으로 테스트 전용 인프라 기동부터 테스트 실행과 정리까지 이어지도록 만들었습니다.

```js
run(`docker compose -f "${composeFile}" up -d --wait`);
try {
  run("pnpm run migration:run");
  run(`pnpm exec jest ${process.argv.slice(2).join(" ")}`);
} finally {
  run(`docker compose -f "${composeFile}" down`);
}
```

실행 순서는 다음과 같습니다.

```text
pnpm test
    ↓
docker compose up
    ↓
healthcheck 통과 대기
    ↓
migration:run
    ↓
Jest 실행
    ↓
docker compose down
```

`--wait`는 컨테이너가 단순히 실행되는 것만 기다리는 것이 아니라 healthcheck가 통과할 때까지 기다립니다.

따라서 Postgres나 Redis가 아직 요청을 받을 준비가 되지 않은 상태에서 테스트가 시작되는 것을 막을 수 있습니다.

또한 `finally`에서 `compose down`을 실행하므로 테스트가 실패하거나 중간에 에러가 발생해도 테스트용 컨테이너를 정리합니다.

## 검증

`pnpm --filter @incident-radar/backend test` 한 번으로 위 흐름(컨테이너 기동 → 마이그레이션 → Jest → 정리)이 모두 실행됩니다.

그중 smoke 테스트가 테스트 인프라 자체를 확인합니다.

* Postgres에 `SELECT 1`
* `to_regclass('public.error_logs')`가 테이블을 반환
* Redis `PING`이 `PONG`을 반환

이제 이후 기능을 구현할 때 테스트 실패의 원인이 애플리케이션 로직인지, 아니면 테스트 인프라 자체의 문제인지 먼저 구분할 수 있는 환경이 준비됐습니다.
