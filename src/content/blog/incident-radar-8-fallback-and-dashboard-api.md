---
title: "[Incident Radar 8] Redis 장애 대응과 대시보드 조회 API"
description: Redis가 불가용해지면 카운팅을 DB 쿼리로 전환하는 fallback 경로와, 프론트 대시보드가 사용하는 /stats·/status·/alerts 조회 API.
pubDate: 2026-09-02
tags: [개발]
seriesOrder: 8
---

7편에서 만든 알림 경로는 카운터, cooldown, BullMQ 큐 모두 Redis에 의존합니다.

이번 편에서는 Redis가 불가용한 상황을 다룹니다. 에러 카운팅은 DB 쿼리로 전환해 감지를 계속하고, 알림 발송은 Redis가 복구될 때까지 중단합니다. 이어서 프론트 대시보드가 사용할 조회 엔드포인트 세 개를 만듭니다.

## Redis 헬스 상태 관리

fallback을 하려면 먼저 Redis가 현재 사용 가능한 상태인지 판단할 기준이 필요합니다. `RedisHealthService`는 그 상태를 `healthy`라는 불린 값으로 유지합니다.

```ts
// apps/backend/src/redis/redis-health.service.ts
constructor(private readonly redis: RedisService) {
  this.redis.client.on("error", () => {
    this._healthy = false;
  });
}

// onModuleInit 이 check() 를 5초 간격으로 실행하도록 setInterval 을 건다
private async check(): Promise<void> {
  try {
    await this.redis.client.ping();
    this._healthy = true;
  } catch {
    this._healthy = false;
  }
}
```

상태를 판단하는 방법은 두 가지입니다. 5초마다 `PING`을 보내 성공 여부로 상태를 갱신하고, 별도로 ioredis 클라이언트의 `error` 이벤트가 발생하면 즉시 `healthy`를 `false`로 바꿉니다.

`PING` 주기만 사용하면 Redis가 죽은 뒤 다음 확인 시점까지 최대 5초 동안 상태 변경이 늦게 반영될 수 있습니다. 반면 실제 Redis 명령에서 오류가 발생하면 `error` 이벤트를 통해 더 빠르게 상태를 내릴 수 있습니다.

`PING`이 실패해도 애플리케이션은 예외를 던지지 않고 상태만 변경합니다. Redis를 사용할 수 없는 상황에서도 서버 자체는 계속 동작해야 하기 때문입니다.

이번 구현에서는 의존성 하나가 장애를 일으켰다고 전체 기능을 멈추는 것보다, 일부 기능을 제한하더라도 에러 감지를 계속하는 방향을 선택했습니다. Redis 장애 때문에 에러 발생 자체를 감지하지 못하는 상황을 피하기 위해서입니다.

`RedisHealthService`는 가짜 ioredis 클라이언트로 유닛 테스트 5개를 확인했습니다.

* `PING` 성공 시 `healthy`가 `true`, 실패 시 `false`
* `error` 이벤트가 발생하면 즉시 `false`
* Redis가 다운된 상태에서 다음 `PING`이 성공하면 `true`로 복구
* `onModuleDestroy` 이후에는 더 이상 `PING`하지 않음

## 카운터 구현 선택

5편의 카운터는 `CounterStrategy` 인터페이스 뒤에 있습니다. `record(service, at)`를 호출하면 그 시각을 기준으로 최근 60초 동안 특정 서비스에서 발생한 에러 개수를 반환합니다. 지금까지는 Redis Sorted Set을 사용하는 구현 하나뿐이었습니다.

이번에는 같은 인터페이스를 구현하는 DB 기반 카운터를 추가하고, Redis 상태에 따라 두 구현 중 하나를 선택합니다.

```text
DetectorService ─→ counter.record()      이 인터페이스만 안다
                        │
                   CounterSelector        healthy 를 보고 한쪽으로 넘긴다
                   ┌────┴────┐
        RedisSlidingWindow      DbCountCounter
        (Redis ZSET)            (error_logs 를 COUNT)
```

`DbCountCounter`는 Redis 대신 `error_logs` 테이블을 조회합니다.

```ts
// apps/backend/src/counter/db-count.counter.ts
record(service: string, at: number): Promise<number> {
  return this.repo.count({
    where: { service, createdAt: MoreThan(new Date(at - this.windowMs)) },
  });
}
```

이름은 `record`지만 DB 구현에서는 별도의 쓰기를 하지 않습니다. 에러 로그는 이미 `ErrorsService`가 저장했기 때문에, 해당 서비스의 최근 윈도우 안 행만 `COUNT`합니다. 이 조회는 3편에서 `error_logs`에 둔 `(service, created_at)` 복합 인덱스가 그대로 받습니다. 경계값을 제외하는 규칙도 Redis 슬라이딩 윈도우 구현과 동일하게 맞췄습니다. Redis보다 매 요청마다 DB 쿼리가 하나 더 발생하지만, Redis가 없어도 감지를 계속하기 위해 이 비용을 감수합니다.

`CounterSelector`는 직접 카운트하지 않습니다. `record()`가 호출될 때마다 현재 `healthy` 값을 확인하고 Redis 또는 DB 카운터 중 하나로 요청을 위임합니다.

```ts
// apps/backend/src/counter/counter.selector.ts
record(service: string, at: number): Promise<number> {
  const impl = this.health.healthy ? this.redisCounter : this.dbCounter;
  return impl.record(service, at);
}
```

`CounterSelector` 역시 `CounterStrategy`를 구현하므로, 모듈에서 기존 카운터 대신 selector를 주입하면 됩니다. `DetectorService`는 계속 `record()`만 호출하고, 실제로 Redis를 쓰는지 DB를 쓰는지는 감지 로직이 알 필요가 없습니다.

### 감지는 계속하고, 알림은 중단한다

Redis가 없어도 DB 카운터를 통해 감지는 계속할 수 있습니다. 하지만 알림 발송은 다릅니다. cooldown과 BullMQ 큐 모두 Redis를 사용하기 때문입니다.

따라서 `DetectorService.check()`는 카운터와 별도로 현재 Redis 상태를 확인합니다. Redis가 다운된 상태에서 임계값을 넘으면 알림을 큐에 넣지 않고 `alert suppressed` 로그만 남깁니다.

```ts
// apps/backend/src/detector/detector.service.ts (check(service, startedAt))
const now = this.clock.now();
const healthy = this.redisHealth.healthy;
const path = healthy ? "redis" : "db-fallback";
const count = await this.counter.record(service, now);

let enqueued = false;
if (count > this.threshold) {
  this.logger.warn(
    `threshold exceeded: service=${service} count=${count} window=${this.windowMs}ms`,
  );
  if (!healthy) {
    this.logger.warn(`alert suppressed: redis down (service=${service} count=${count})`);
  } else if (await this.cooldown.tryAcquire(service)) {
    await this.alerts.enqueue({ /* ... */ });
    enqueued = true;
  }
}

this.logger.log(
  `ingest path=${path} service=${service} count=${count} enqueued=${enqueued} latencyMs=${Date.now() - startedAt}`,
);
```

읽어 둔 `healthy`는 7편에서 추가한 지연 로그의 `path` 필드에도 쓰입니다. Redis를 사용하면 `redis`, DB fallback을 사용하면 `db-fallback`이 기록됩니다.

`DbCountCounter`와 `CounterSelector`는 각각 유닛 테스트 3개로 확인했습니다.

* 윈도우 안의 해당 서비스 에러만 세고, 경계값과 다른 서비스는 제외한다
* `healthy` 값에 따라 Redis 또는 DB 카운터로 위임한다
* 호출 시점의 상태에 따라 매번 경로를 다시 선택한다

fallback 경로 전체는 e2e 테스트로 확인했습니다. `RedisHealthService`를 `healthy=false`로 오버라이드한 뒤 `POST /errors`를 15회 보내면, 모든 요청이 201로 응답하고 `error_logs`에 15행이 저장되며 `alerts` 테이블에는 행이 추가되지 않습니다. 실제 Redis 프로세스를 종료하는 방식은 이후 CI에서 불안정할 수 있어 이 방식으로 대체했습니다.

로컬에서는 dev 스택을 실행한 상태로 `docker compose stop redis`를 실행했습니다. 시뮬레이터를 계속 실행하면 `POST /errors`는 여전히 201로 응답하고, 백엔드 로그의 `path`가 `db-fallback`으로 바뀌며 임계값을 넘긴 요청에는 `alert suppressed` 로그가 남습니다. `docker compose start redis` 이후 5초 안에 `path`가 다시 `redis`로 돌아옵니다.

<!-- 스크린샷 자리: docker compose stop redis 이후 백엔드 로그 — path=db-fallback 과 alert suppressed 가 보이는 부분 -->

## 대시보드 조회 API

여기까지가 에러를 저장하고 감지하는 쓰기 경로입니다. 이번에는 프론트 대시보드가 사용할 조회 API를 추가합니다.

수집 API와 조회 API는 관심사가 다르기 때문에, 대시보드용 조회 로직은 `DashboardService`로 분리했습니다. `error_logs`를 조회하더라도 화면이 필요한 형태로 데이터를 만드는 역할은 별도로 두는 편이 더 명확합니다.

### GET /stats

지정한 시간 구간을 버킷으로 나눈 서비스별 에러 수를 반환합니다.

```ts
// apps/backend/src/dashboard/dashboard.service.ts
const qb = this.errorLogs
  .createQueryBuilder("e")
  .select("e.service", "service")
  .addSelect(
    `to_timestamp(floor(extract(epoch from e.created_at) / ${bucket}) * ${bucket})`,
    "t",
  )
  .addSelect("count(*)", "count")
  .where("e.created_at >= :from AND e.created_at < :to", { from, to })
  .groupBy("e.service")
  .addGroupBy("t")
  .orderBy("e.service")
  .addOrderBy("t");
```

`extract(epoch from created_at)`으로 시간을 초 단위 숫자로 바꾸고, `floor(... / bucket) * bucket`으로 버킷 시작 시각에 맞춰 내립니다. `bucket`이 60초라면 10:00:37과 10:00:59는 모두 10:00:00 버킷에 들어갑니다. 같은 서비스와 같은 버킷끼리 `count(*)`하면 서비스별 시계열이 나옵니다.

`bucket`은 쿼리스트링으로 받고 스키마에서 10초~3600초 범위의 정수로 제한합니다. `from`과 `to`를 생략하면 최근 60분을 조회합니다.

응답은 서비스별로 묶은 배열입니다.

```json
[{ "service": "checkout", "buckets": [{ "t": "2026-09-02T12:33:00.000Z", "count": 24 }] }]
```

### GET /status

최근 24시간 동안 에러가 발생한 서비스마다 최근 윈도우 안의 에러 수와 cooldown 상태를 붙입니다.

```ts
// apps/backend/src/dashboard/dashboard.service.ts
const windowCount = await this.errorLogs.count({
  where: { service, createdAt: MoreThan(windowStart) },
});
let cooldownTtlSec: number | null = null;
try {
  cooldownTtlSec = await this.cooldown.getTtl(service);
} catch {
  // Redis 다운 — cooldown 상태를 확인할 수 없음
}
```

`windowCount`는 Redis Sorted Set이 아니라 DB `COUNT`로 계산합니다. 대시보드는 폴링으로 조회하고 Redis가 다운된 상황에서도 값을 보여줘야 하기 때문입니다.

`cooldownTtlSec`는 Redis의 `cooldown:<service>` 키에 남은 TTL을 읽습니다. 7편의 `tryAcquire`는 `SET ... NX`로 키를 만들어 조회에 쓸 수 없으므로, `TTL` 명령만 보내는 읽기 전용 메서드를 추가했습니다.

```ts
// apps/backend/src/cooldown/cooldown.service.ts
async getTtl(service: string): Promise<number | null> {
  const ttl = await this.redis.client.ttl(`cooldown:${service}`);
  return ttl > 0 ? ttl : null;
}
```

Redis가 다운되면 이 호출이 실패하는데, 대시보드 전체가 같이 실패하지 않도록 `null`로 처리합니다.

### GET /alerts

`alerts`(발송 성공)와 `alert_failures`(재시도 소진)에서 각각 최근 `limit`건을 가져와 합친 뒤, 시간 역순으로 정렬하고 `limit`만큼 반환합니다.

응답 요소는 `status`로 나뉘는 판별 유니온입니다. `dispatched`면 `count`·`threshold`·`windowMs`가, `failed`면 `attempts`·`error`가 채워집니다. `at`은 각각 `alerts.at`과 `alert_failures.failed_at`에서 가져옵니다.

`StatsResponse`·`ServiceStatus`는 이번에 공유 패키지에 새로 정의했고, `Alert`는 1편에서 정의한 판별 유니온을 그대로 씁니다. 프론트에서는 세 응답 모두 이 스키마로 다시 파싱한 뒤 화면에 사용합니다.

`DashboardService`는 실제 테스트 DB로 세 메서드를 유닛 테스트 6개로 확인했습니다.

* `stats` — 버킷 집계, `service` 필터, `from`/`to` 범위
* `status` — 최근 24시간에 등장한 서비스만, `windowCount`와 cooldown 상태
* `recentAlerts` — 두 테이블 병합, `status`에 따른 필드 분기, `limit` 적용 시점

조회 경로 전체는 스펙의 e2e 세트로 확인합니다. 버스트를 보내 `alerts`에 1행이 생긴 뒤, `/errors`·`/stats`·`/status`·`/alerts` 네 응답이 모두 공유 스키마 검증을 통과하고 값도 기대와 일치하는지 봅니다. 전체 스위트 14개, 테스트 56개입니다.
