---
title: "[Incident Radar 6] 에러 감지 연결과 트래픽 시뮬레이터"
description: POST /errors 저장 직후 카운터를 호출해 임계값 초과를 로그로 남기는 DetectorService, 그리고 그 경로를 반복 실행해볼 트래픽 시뮬레이터.
pubDate: 2026-09-02
tags: [개발]
seriesOrder: 6
---

5편에서 만든 슬라이딩 윈도우 카운터를 이번 편에서 `POST /errors` 요청 흐름에 연결합니다.

에러를 저장한 직후 카운터의 `record()`를 호출하고, 최근 60초 동안의 카운트가 임계값을 넘으면 로그를 남기는 `DetectorService`를 만듭니다.

그리고 이 감지 경로를 반복해서 실행해볼 수 있도록 `tools/`에 트래픽 시뮬레이터도 추가합니다.

이번 편에서는 임계값을 감지하고 로그를 남기는 데까지 구현합니다. 실제 알림을 보내는 cooldown, 큐, webhook은 다음 편에서 다룹니다.

## DetectorService

저장된 에러를 카운터에 반영하고 임계값을 넘었는지 확인하는 로직은 `DetectorService`로 분리했습니다.

`ErrorsService`는 에러 저장만 담당합니다. 이후 추가할 cooldown 확인, 알림 큐, 카운터 교체처럼 감지 이후의 처리들이 이 흐름에 계속 연결될 예정이기 때문에 처음부터 역할을 나눴습니다.

`check()`는 에러 한 건이 저장될 때마다 호출됩니다.

`record()`로 이번 이벤트를 카운터에 추가하고 최근 60초 동안의 개수를 받아옵니다. 그 값이 임계값(`ALERT_THRESHOLD`, 기본값 10)을 넘으면 서비스 이름, 현재 개수, 집계 시간을 담은 경고 로그를 남깁니다.

```ts
// apps/backend/src/detector/detector.service.ts
async check(service: string): Promise<void> {
  const count = await this.counter.record(service, this.clock.now());
  if (count > this.threshold) {
    this.logger.warn(
      `threshold exceeded: service=${service} count=${count} window=${this.windowMs}ms`,
    );
  }
}
```

`this.counter`의 타입은 구체적인 클래스가 아니라 5편에서 정의한 `CounterStrategy` 인터페이스입니다.

그래서 `DetectorService` 코드에는 Redis가 등장하지 않고, `record()`를 호출해 숫자를 받을 뿐입니다. 이후 편에서 Redis 대신 DB 쿼리로 개수를 세는 구현으로 바꿀 때도, 교체는 모듈의 의존성 설정에서만 일어나고 `DetectorService`는 수정하지 않습니다.

현재 시각도 5편에서 주입 가능하게 만든 `Clock`을 통해 `this.clock.now()`로 가져옵니다.

컨트롤러에서는 에러를 저장한 직후 `check()`를 호출합니다.

```ts
// apps/backend/src/errors/errors.controller.ts
@Post()
async create(@Body(new ZodValidationPipe(ErrorLogInput)) body: ErrorLogInput) {
  const saved = await this.errors.create(body);
  await this.detector.check(body.service);
  return saved;
}
```

현재 구조에서는 `check()`가 실패하면 Redis 장애 등으로 감지에 실패한 경우 요청 전체가 500으로 응답됩니다.

에러 저장 자체는 이미 완료된 상태입니다.

감지 실패가 API 요청까지 실패시키지 않도록 분리하는 처리는 다음 편에서 다룹니다.

이 로직은 가짜 카운터와 `Clock`으로 유닛 테스트 3개로 확인했습니다.

* `record()`가 `Clock.now()`의 시각으로 호출되는지
* 카운트가 임계값 이하면 로그가 남지 않는지
* 카운트가 임계값을 넘으면 서비스 이름·개수·집계 시간을 담은 로그가 한 번 남는지

카운터가 실제 요청 흐름에 연결됐는지는 e2e 테스트로 확인했습니다. 같은 서비스로 `POST` 요청을 11회 보내면 10번째까지는 로그가 없고, 11번째에 `threshold exceeded` 로그가 나타납니다.

## 트래픽 시뮬레이터

감지 경로를 직접 확인하려면 하나의 서비스에서 60초 안에 11건 이상의 에러가 발생하는 상황을 만들어야 합니다.

`curl`을 반복 실행해 이 상황을 만드는 것은 번거롭기 때문에, 가짜 에러 트래픽을 반복 생성하는 스크립트를 `tools/` 워크스페이스 패키지에 추가하고 `tsx`로 실행합니다. 이 프로젝트에는 실제로 에러를 보고하는 애플리케이션이 없기 때문입니다.

```text
pnpm --filter @incident-radar/tools sim -- --duration 10s
pnpm --filter @incident-radar/tools sim -- --spike checkout
```

일반 트래픽은 가짜 서비스(`checkout`, `auth`, `search`, `payments`)를 가중치대로 골라 불규칙한 간격으로 보냅니다. 이 편에서 쓰는 옵션은 `--spike <service>`로, 시작하자마자 해당 서비스에 15건(기본 임계값 10 초과)을 연속 전송한 뒤 일반 트래픽으로 돌아갑니다.

```ts
// tools/simulator.ts
if (cfg.spike) {
  console.log(`spike: ${cfg.spike} 에 ${SPIKE_BURST}연발`);
  for (let i = 0; i < SPIKE_BURST; i++) {
    bump(cfg.spike, await postError(cfg.url, cfg.spike));
  }
}
```

`postError`는 `POST /errors`를 한 번 보내고 성공 여부를 반환하며, `bump`은 전송 건수를 집계합니다.

인자 파싱과 간격 계산 같은 계산 함수는 `export`해 Vitest 유닛 테스트 11개로 확인했고, HTTP 요청과 타이머가 있는 `run()`은 파일을 직접 실행할 때만 돌게 분리했습니다.

감지와 시뮬레이터를 함께 돌려서도 확인했습니다. `sim --spike checkout`을 실행하면 `spike: checkout 에 15연발`을 출력하고, 백엔드 로그에는 11번째 요청부터 `threshold exceeded` 로그가 나타납니다.

## 겪은 문제 — 병렬 테스트가 같은 Redis를 공유

DetectorService e2e 테스트를 추가한 뒤 기존 테스트가 간헐적으로 실패했습니다.

카운터는 Redis Sorted Set과 TTL의 실제 동작 자체가 검증 대상이기 때문에, 테스트에서도 목 대신 실제 테스트용 Redis에 연결합니다.

대신 테스트 간 격리를 위해 공용 `afterEach`에서 매번 `flushdb`로 Redis 전체를 비웁니다.

문제는 Jest가 테스트 파일을 병렬로 실행할 수 있고, 테스트에서 사용하는 Redis는 하나뿐이라는 점입니다.

여러 테스트가 동시에 같은 Redis에 연결된 상태에서 각 테스트가 끝날 때마다 Redis 전체를 비우고 있었습니다.

이번 편 전까지 e2e 테스트는 Redis 키를 직접 사용하지 않아 이 충돌이 드러나지 않았습니다.

새로 추가한 DetectorService e2e 테스트는 같은 서비스로 `POST` 요청을 11회 보내며 카운터 키를 쌓고, 11번째 요청에서 카운트가 11인지 확인합니다.

이 11번의 요청 사이에 다른 테스트의 `flushdb`가 실행되면 카운트가 초기화돼 11에 도달하지 못하고 테스트가 실패합니다.

```ts
// apps/backend/jest.config.ts
maxWorkers: 1,
```

`maxWorkers: 1`로 설정해 테스트 파일을 한 번에 하나씩 실행하도록 변경했습니다.

이렇게 하면 다른 테스트의 `afterEach`가 실행 중인 테스트에 끼어들어 Redis를 비울 수 없습니다.

현재는 스위트가 4개뿐이라 직렬 실행으로 인한 비용이 거의 없습니다.

나중에 테스트 규모가 커져 실행 시간이 문제가 된다면 Jest 프로젝트별로 Redis DB 번호를 나눠, 각자의 `flushdb`가 자기 DB만 비우게 하면 병렬 실행을 되살릴 수 있습니다.
