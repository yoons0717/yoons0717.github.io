---
title: "[Incident Radar 11] 헬스체크와 CI"
description: DB·Redis 상태를 반영하는 /health와 GitHub Actions CI를 만들고, 실제 장애를 검증하는 과정에서 발견한 로깅 버그를 고칩니다.
pubDate: 2026-09-07
tags: [개발]
seriesOrder: 11
---

10편에서 프론트 대시보드를 끝내고 다시 백엔드로 돌아왔습니다.

이번 편에서는 지금까지 스텁이었던 `/health`를 실제로 동작하게 만들고, GitHub Actions CI를 세팅합니다.

`/health`는 구현 자체보다 실제로 검증하는 과정에서 의미가 있었습니다. 로컬 인프라를 직접 내려보면서, 로깅에 있던 버그를 하나 발견하고 수정했습니다.

## /health를 실제 상태에 연결하기

지금까지 `/health`는 DB가 죽어도, Redis가 죽어도 `{ status: "ok" }`만 반환하는 스텁이었습니다.

이 서비스에서 DB는 에러 로그를 저장하고 대시보드 조회에 사용하는 핵심 의존성입니다. DB에 접근할 수 없으면 정상 동작으로 볼 수 없으므로 `503`을 반환합니다.

반면 Redis는 8편에서 다룬 것처럼 fail-open으로 설계했습니다. Redis가 다운되어도 DB fallback으로 에러 감지는 계속되므로 HTTP 상태는 `200`으로 유지하고, 대신 `degraded` 상태를 반환합니다.

```ts
// apps/backend/src/health/health.service.ts

async check(): Promise<HealthResult> {
  await this.checkDb();

  return this.redisHealth.healthy
    ? { status: "ok" }
    : { status: "degraded", redis: "down" };
}
```

DB는 실제 쿼리로 확인합니다.

```ts
private async checkDb(): Promise<void> {
  let timer!: NodeJS.Timeout;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("db health check timeout")),
      HealthService.DB_TIMEOUT_MS,
    );
  });

  try {
    await Promise.race([
      this.dataSource.query("SELECT 1"),
      timeout,
    ]);
  } catch (err) {
    this.logger.error(
      `db health check failed: ${describeError(err)}`,
    );

    throw new ServiceUnavailableException("db unavailable");
  } finally {
    clearTimeout(timer);
  }
}
```

`SELECT 1`에 1.5초 타임아웃을 둔 이유는 DB 연결이나 응답이 예상보다 오래 걸릴 때 헬스체크 요청까지 계속 대기하지 않도록 하기 위해서입니다.

`Promise.race`로 DB 응답과 타임아웃 중 먼저 끝나는 쪽을 사용하고, 어느 쪽이 먼저 끝나든 타이머는 `finally`에서 정리합니다.

다만 이 타임아웃이 이미 시작된 DB 쿼리를 취소하는 것은 아닙니다.

로직을 검증하려고 실제 로컬 Postgres 컨테이너를 내리고 `/health`를 호출했습니다. `503`은 정상적으로 반환됐지만, 로그에는 `db health check failed:`처럼 원인이 빈 문자열로 찍혔습니다.

Postgres 연결 실패가 `AggregateError`(IPv4·IPv6 양쪽 연결 시도가 각각 실패한 걸 하나로 묶은 것)로 전달됐는데, 이 객체는 최상위 `message`가 비어 있고 실제 원인은 내부 `errors` 배열에 있었습니다.

```ts
function describeError(err: unknown): string {
  if (err instanceof AggregateError) {
    const inner = err.errors
      .map((e) => (e instanceof Error ? e.message : String(e)))
      .join("; ");
    const code = (err as NodeJS.ErrnoException).code;

    return inner || code || err.message || String(err);
  }

  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;

    return err.message || code || String(err);
  }

  return String(err);
}
```

이제 같은 상황에서 로그에 실제 연결 실패 원인이 남습니다.

```text
connect ECONNREFUSED ::1:5432;
connect ECONNREFUSED 127.0.0.1:5432
```

Postgres와 Redis를 각각 내려 세 가지 상태를 확인했습니다.

| DB | Redis | 응답                                          |
| -- | ----- | ------------------------------------------- |
| 정상 | 정상    | `200 { status: "ok" }`                      |
| 정상 | 다운    | `200 { status: "degraded", redis: "down" }` |
| 다운 | 상태 무관 | `503`                                       |

## GitHub Actions CI

다음으로 `push`와 `pull request`마다 lint·typecheck·test를 자동으로 실행하는 CI를 만들었습니다.

```yaml
# .github/workflows/ci.yml (일부)

- uses: actions/checkout@v4

- uses: pnpm/action-setup@v4
  with:
    version: 9.15.0

- uses: actions/setup-node@v4
  with:
    node-version-file: .nvmrc
    cache: pnpm

- run: pnpm install --frozen-lockfile

- run: pnpm lint

- run: pnpm typecheck

- run: pnpm test
```

백엔드의 `test` 스크립트는 이미 `docker-compose.test.yml`로 Postgres와 Redis를 띄우고, 마이그레이션까지 실행하도록 만들어 두었습니다.

CI 전용으로 GitHub Actions `services`를 다시 정의하지 않고 기존 compose 구성을 그대로 사용해서, 로컬과 CI가 같은 인프라 구성을 씁니다.

실제로 push해서 GitHub Actions가 초록으로 끝나는 것까지 확인했습니다.
