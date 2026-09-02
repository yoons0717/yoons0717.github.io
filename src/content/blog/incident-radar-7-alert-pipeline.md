---
title: "[Incident Radar 7] 알림 발송: cooldown, 큐, webhook"
description: 임계값 초과를 실제 알림으로 바꾸는 경로. SET NX EX 기반 cooldown, BullMQ 큐와 워커, webhook 발송과 재시도, 재시도 중복을 식별하기 위한 멱등성 키.
pubDate: 2026-09-02
tags: [개발]
seriesOrder: 7
---

6편에서는 임계값을 넘긴 에러를 감지하고 로그를 남기는 데까지 만들었습니다.

이번 편에서는 그 감지 결과에 실제 알림 발송을 연결합니다. 같은 알림이 반복해서 전송되지 않도록 cooldown으로 제한하고, 발송 작업은 BullMQ 큐에 넣어 워커가 처리합니다. webhook 호출이 실패하면 재시도합니다.

이후 Redis 장애 fallback과 대시보드 조회도 이 알림 큐와 기록 테이블을 기반으로 동작합니다. 그래서 이번 편에서 먼저 알림 발송 경로를 구성합니다.

## Cooldown

한 서비스에서 에러가 계속 발생하면 임계값을 넘는 상태가 일정 시간 계속될 수 있습니다. 이때 `check()`가 호출될 때마다 알림을 보내면 짧은 시간에 수십 건의 알림이 발송될 수 있습니다.

`CooldownService.tryAcquire()`는 Redis `SET` 한 번으로 지금 이 서비스에 알림을 보내도 되는지 판정합니다.

```ts
// apps/backend/src/cooldown/cooldown.service.ts
async tryAcquire(service: string): Promise<boolean> {
  const res = await this.redis.client.set(
    `cooldown:${service}`,
    "1",
    "EX",
    this.cooldownSec,
    "NX",
  );
  return res === "OK";
}
```

`NX`는 키가 없을 때만 값을 설정하고, `EX`는 만료 시간(초)을 지정합니다.

키가 없으면 `"OK"`를 반환해 이번 알림이 cooldown을 통과했음을 나타냅니다. 이미 키가 있으면 `null`을 반환합니다. 만료 시간이 지나 키가 사라지면 다음 알림은 다시 통과할 수 있습니다.

`GET`으로 키 존재 여부를 확인한 뒤 `SET`하는 방식은 그 사이에 다른 요청이 끼어들 수 있습니다. 반면 `SET ... NX EX`는 하나의 Redis 명령으로 판정과 설정을 함께 처리하므로 이런 경쟁 조건을 피할 수 있습니다.

기본 cooldown 시간은 `ALERT_COOLDOWN_SEC` 환경변수로 받고 기본값은 300초입니다.

현재 cooldown은 `service` 이름만 기준으로 알림을 묶습니다. 따라서 한 서비스에서 서로 다른 원인의 에러가 동시에 발생해도 하나의 알림으로 제한되고, cooldown이 만료된 뒤 다시 에러가 발생하면 새로운 알림이 가능합니다.

실제 Sentry나 PagerDuty 같은 도구는 이보다 더 정교한 기준으로 이벤트를 그룹핑합니다.

| | 이 프로젝트 | 실무 도구 |
|---|---|---|
| 무엇을 한 건으로 보나 | 서비스 이름 | 스택트레이스·메시지로 만든 지문 |
| 재알림 억제 | 서비스별 5분 고정 | 중복 키 + 시간·내용 기반 그룹핑 |
| 장애 종료 인지 | 없음 (5분 뒤 재알림 가능) | resolve 신호나 자동 해제 + 열림/닫힘 상태 |

에러 지문 그룹핑이나 서비스별 임계값은 이번 범위에 넣지 않았습니다.

`CooldownService`는 실제 테스트 Redis에 연결해 유닛 테스트 4개로 확인했습니다.

* 첫 획득은 성공
* cooldown이 살아있는 동안 재획득은 실패
* 만료 후 다시 획득하면 성공
* 서비스별 cooldown은 서로 독립

## 알림 큐와 워커

webhook 호출은 느릴 수 있고 실패할 수도 있습니다. `POST /errors`의 응답이 webhook 처리 시간에 직접 묶이지 않도록, 알림 발송은 BullMQ 큐에 넣고 워커가 별도로 처리합니다.

BullMQ는 Redis 위에서 동작하는 Node용 작업 큐로, 재시도 횟수·백오프·실패한 잡 처리를 옵션으로 제공합니다.

카운터와 cooldown 때문에 이미 Redis를 쓰고 있어 별도 브로커가 필요 없고, 여기서 필요한 재시도·백오프가 라이브러리에 들어 있어서 선택했습니다.

Postgres 아웃박스 테이블로도 만들 수 있지만 폴링과 재시도를 직접 구현해야 합니다.

`DetectorService.check()`는 임계값을 넘긴 뒤 cooldown을 획득한 요청만 알림 큐에 잡을 추가합니다.

```ts
// apps/backend/src/detector/detector.service.ts
if (await this.cooldown.tryAcquire(service)) {
  await this.alerts.enqueue({
    service,
    count,
    threshold: this.threshold,
    windowMs: this.windowMs,
    windowStart: Math.floor(now / this.windowMs) * this.windowMs,
  });
}
```

큐에 추가할 때는 최대 시도 횟수와 지수 백오프를 지정합니다.

```ts
// apps/backend/src/alerts/alerts.service.ts
await this.queue.add("dispatch", data, {
  attempts: 5,
  backoff: { type: "exponential", delay: 1000, jitter: 0.2 },
  removeOnComplete: true,
  removeOnFail: true,
});
```

`attempts: 5`는 최초 시도 1회와 재시도 4회를 의미합니다.

`exponential`과 `delay: 1000`을 사용하면 재시도 간격은 1초, 2초, 4초, 8초처럼 점점 늘어납니다.

`jitter: 0.2`는 각 대기 시간을 최대 20%까지 줄여 여러 알림이 동시에 실패했을 때 재시도가 같은 시점에 몰리는 것을 완화합니다.

워커는 잡을 하나씩 받아 `dispatch()`를 호출합니다.

`WEBHOOK_URL`이 없으면 실제 HTTP 요청 대신 로그를 남기고, webhook 응답이 2xx가 아니면 예외를 던져 BullMQ가 재시도하도록 합니다.

```ts
// apps/backend/src/alerts/alerts.service.ts
async dispatch(data: AlertJobData): Promise<void> {
  const payload = { ...data, at: new Date().toISOString() };
  if (this.webhookUrl) {
    const res = await fetch(this.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-idempotency-key": `${data.service}:${data.windowStart}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`webhook responded ${res.status}`);
  } else {
    this.logger.log(`alert dispatched (no webhook): ${JSON.stringify(payload)}`);
  }
  await this.alerts.insert({
    service: data.service,
    count: data.count,
    threshold: data.threshold,
    windowMs: data.windowMs,
  });
}
```

webhook 발송에 성공하면 `alerts` 테이블에 기록을 남깁니다.

반대로 모든 시도를 소진하면, 즉 총 5회 모두 실패하면 워커의 `failed` 이벤트 핸들러가 `alert_failures` 테이블에 발송하려던 내용과 마지막 에러, 시도 횟수를 기록합니다.

```ts
// apps/backend/src/alerts/alerts.processor.ts
@OnWorkerEvent("failed")
async onFailed(job: Job<AlertJobData>): Promise<void> {
  const maxAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < maxAttempts) return;
  await this.alerts.recordFailure(
    job.data,
    job.failedReason ?? "unknown",
    job.attemptsMade,
  );
}
```

실패 이력을 `alerts` 테이블의 상태 컬럼으로 관리하지 않고 별도 테이블로 분리한 것은 실패한 알림 자체를 조회하는 요구가 따로 있기 때문입니다. 이 조회 엔드포인트는 이후 편에서 추가합니다.

`AlertsProcessor`는 `@Processor`와 `failed` 이벤트를 연결하는 얇은 어댑터 역할만 합니다. 실제 발송과 기록 로직은 `AlertsService`에 두었습니다.

따라서 큐를 직접 실행하지 않고도 `dispatch()`와 `recordFailure()`를 호출해 로직을 테스트할 수 있습니다.

`AlertsService`는 실제 테스트 DB와 목킹한 `fetch`로 유닛 테스트 5개를 확인했고, `AlertsProcessor`는 유닛 테스트 2개로 확인했습니다.

* webhook 유무에 따른 실제 발송·로그 대체
* webhook 응답이 2xx가 아니면 예외를 던지고 `alerts` 행을 남기지 않는지
* `recordFailure()`가 실패 행을 남기는지
* `onFailed()`가 마지막 시도에서만 실패를 기록하는지

## 멱등성 키

BullMQ의 재시도는 at-least-once 방식입니다. 즉, 같은 알림이 한 번 이상 전달될 가능성이 있습니다.

예를 들어 webhook 서버는 요청을 정상적으로 처리했지만, 응답을 받기 전에 연결이 끊길 수 있습니다. 이 경우 발송한 쪽에서는 성공 여부를 알 수 없으므로 같은 알림을 다시 전송할 수 있습니다.

수신 측에서 이런 중복 요청을 식별할 수 있도록 `x-idempotency-key` 헤더를 붙입니다.

값은 `<service>:<윈도우 버킷의 시작 시각(밀리초)>` 형태이며, enqueue 시점에 계산해 잡 데이터의 `windowStart`에 넣습니다.

재시도는 같은 잡 데이터를 그대로 사용하므로 `windowStart`도 변하지 않습니다. 몇 초 뒤에 재시도되더라도 같은 멱등성 키가 전달되고, 수신 측은 두 요청이 같은 알림이라는 것을 식별할 수 있습니다.

에러 감지는 슬라이딩 윈도우를 사용하지만, 멱등성 키는 `floor(now / windowMs) * windowMs`로 계산한 고정 버킷 기준을 사용합니다.

## 지연 로깅

`POST /errors` 핸들러에 들어온 시각을 `check()`에 전달하고, 감지가 끝난 시점과의 차이를 매 요청 로그로 남깁니다.

임계값을 넘었는지와 관계없이 요청마다 한 줄씩 기록합니다.

```ts
// apps/backend/src/detector/detector.service.ts
this.logger.log(
  `ingest path=redis service=${service} count=${count} enqueued=${enqueued} latencyMs=${Date.now() - startedAt}`,
);
```

```text
ingest path=redis service=checkout count=11 enqueued=true latencyMs=5
```

`path`는 현재 `redis`로 고정되어 있습니다. 이후 Redis 장애 시 DB로 집계하는 fallback 경로가 추가되면 이 값도 실제 처리 경로에 따라 달라집니다.

로그 포맷 자체는 이후 pino를 도입하는 편에서 정리합니다.

## 검증

전체 알림 경로는 e2e 테스트로 확인했습니다.

같은 서비스로 `POST` 요청을 15회 보내면 실제 BullMQ 워커가 잡을 처리하고 `alerts` 테이블에 1행이 생성됩니다.

첫 알림 이후에는 cooldown이 유지되므로 나머지 14건은 알림 큐에 추가되지 않습니다. `alert_failures` 테이블은 비어 있고, `error_logs`에는 15건이 모두 저장됩니다.

실행해서도 확인했습니다.

`WEBHOOK_URL`을 요청 내용을 출력하는 로컬 서버로 지정한 뒤 `sim --spike checkout`을 실행하면, 해당 서버에는 POST 요청이 1건 도착하고 헤더에는 `x-idempotency-key: checkout:<숫자>`가 포함됩니다.

반대로 `WEBHOOK_URL`을 응답하지 않는 주소로 바꾸면 BullMQ가 재시도를 반복하고, 모든 시도를 소진한 뒤 `alert_failures`에 1행이 생성됩니다. 이때 `attempts`는 5로 기록됩니다.
