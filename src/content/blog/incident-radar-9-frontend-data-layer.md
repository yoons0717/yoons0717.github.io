---
title: "[Incident Radar 9] 프론트 데이터 계층과 폴링"
description: API 클라이언트와 응답 검증부터 TanStack Query 기반 데이터 관리, 5초 폴링까지.
pubDate: 2026-09-04
tags: [개발]
seriesOrder: 9
---

8편에서 프론트가 사용할 조회 엔드포인트 `/stats`, `/status`, `/alerts`를 만들었습니다.

이번 편에서는 화면을 만들기 전에 프론트의 데이터 계층을 먼저 붙입니다. API를 호출하고 응답을 검증하는 부분부터, 대시보드를 5초 간격으로 갱신하는 폴링까지 구현합니다.

컴포넌트가 훅을 호출하면 쿼리 팩토리 → 엔드포인트 → `apiGet`을 거쳐 검증된 값이 돌아오고, TanStack Query가 그 값을 캐시하며 5초마다 다시 호출합니다. 화면 컴포넌트 자체는 다음 편에서 다룹니다.

## API 응답을 경계에서 다시 검증한다

응답 타입은 공유 패키지의 Zod 스키마에서 `z.infer`로 파생합니다.

```ts
// packages/shared/src/schemas.ts
export const StatsBucket = z.object({
  t: isoDateTime,
  count: z.number().int().nonnegative(),
});
export const StatsSeries = z.object({
  service: serviceName,
  buckets: z.array(StatsBucket),
});
export const StatsResponse = z.array(StatsSeries);
export type StatsResponse = z.infer<typeof StatsResponse>;
```

타입은 빌드 시점에 지워지므로, 실행 중인 서버가 실제로 이 형태를 반환한다는 보장은 없습니다. 스키마를 바꾸고 한쪽만 배포했거나 중간 프록시가 에러 본문을 끼워 넣으면 타입과 실제 값이 어긋납니다. 그래서 `apiGet`은 응답을 받은 경계에서 같은 스키마로 한 번 더 검증합니다.

```ts
// apps/frontend/lib/api/client.ts
export type ApiErrorKind = "network" | "http" | "parse";

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiGet<T>(path: string, schema: ZodType<T>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { headers: { accept: "application/json" } });
  } catch (e) {
    throw new ApiError("network", `요청 실패: GET ${path}`, e);
  }
  if (!res.ok) {
    throw new ApiError("http", `GET ${path} → ${res.status} ${res.statusText}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    throw new ApiError("parse", `JSON 파싱 실패: GET ${path}`, e);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError("parse", `응답 스키마 불일치: GET ${path}`, parsed.error);
  }
  return parsed.data;
}
```

실패는 종류로 구분해 던집니다.

* `network` — `fetch` 자체가 실패한 경우 (백엔드 다운, CORS, DNS)
* `http` — 응답은 왔지만 2xx가 아닌 경우
* `parse` — 본문이 JSON이 아니거나 스키마에 맞지 않는 경우

덕분에 화면에서는 오류 원인을 직접 판단하지 않고 `ApiError`의 `kind`만 보고 분기할 수 있습니다. API 응답이 바뀌었는데 프론트 타입만 고쳐서 넘어가는 상황도 이 경계에서 걸립니다.

`apiGet`은 가짜 `fetch`로 유닛 테스트 5개를 확인했습니다. 정상 응답을 스키마로 파싱해 반환하고, 본문이 JSON이 아니거나 스키마에 맞지 않으면 `kind: "parse"`, 2xx가 아니면 `kind: "http"`(메시지에 상태 코드 포함), `fetch`가 던지면 `kind: "network"`입니다.

## 요청이 거치는 계층

`apiGet` 위에 `endpoints.ts` → `queries.ts` → `hooks.ts` 세 계층을 얹었습니다. 컴포넌트가 쓰는 건 마지막 훅 하나입니다.

* `endpoints.ts` — 파라미터를 쿼리스트링으로 조립해(밀리초를 ISO로 변환, 값 없는 키는 생략) `apiGet`을 호출합니다. `getStats`, `getStatus`, `getAlerts`.
* `queries.ts` — `useQuery`에 넘길 `{ queryKey, queryFn }` 객체를 만드는 순수 팩토리입니다. `statsQuery`, `statusQuery`, `alertsQuery`.
* `hooks.ts` — 팩토리에 `useQuery`를 씌운 한 줄입니다.

```ts
// apps/frontend/lib/api/hooks.ts
export function useStats(params: StatsQueryParams) {
  return useQuery(statsQuery(params));
}
export function useStatus() {
  return useQuery(statusQuery());
}
export function useAlerts(limit?: number) {
  return useQuery(alertsQuery(limit));
}
```

팩토리를 훅에서 분리한 이유는 테스트 때문입니다. `queryKey`가 파라미터에 따라 어떻게 달라지는지, `queryFn`이 어떤 인자로 엔드포인트를 호출하는지는 순수 함수인 팩토리만 보면 확인됩니다. `endpoints.ts`는 유닛 테스트 6개, `queries.ts`는 5개로 확인했습니다.

이 편에서는 훅을 정의만 하고 호출하는 컴포넌트는 없습니다.

## 서버 상태는 Query, 화면 상태는 Zustand

계층이 돌려준 데이터는 서버에서 온 값입니다. 서비스별 에러 시계열(`/stats`), 서비스별 최근 상태와 cooldown(`/status`), 최근 알림 이력(`/alerts`)이고, 서버가 원본을 갖고 있고 프론트는 사본을 잠깐 들고 있을 뿐입니다. 이 값들은 TanStack Query가 캐시 키 단위로 관리합니다.

반면 어떤 서비스를 선택했는지, 몇 시간 범위를 볼지는 서버와 무관한 화면 상태입니다. 이쪽만 Zustand 스토어에 둡니다.

```ts
// apps/frontend/lib/store.ts
export type RangeMinutes = 60 | 360 | 1440;
interface DashboardUiState {
  service: string | null;
  rangeMinutes: RangeMinutes;
  setService: (service: string | null) => void;
  setRange: (rangeMinutes: RangeMinutes) => void;
}
export const useDashboardUi = create<DashboardUiState>((set) => ({
  service: null,
  rangeMinutes: 60,
  setService: (service) => set({ service }),
  setRange: (rangeMinutes) => set({ rangeMinutes }),
}));
```

서버 응답까지 이 스토어에 복사하면 언제 다시 가져올지, 오래된 값을 언제 버릴지, 요청이 진행 중인지를 직접 관리해야 합니다. 스토어에는 선택 서비스와 기간만 남깁니다. 스토어는 `getState`/`setState`로 유닛 테스트 2개(기본값, `setService`/`setRange`)를 확인했습니다.

## 5초 폴링

대시보드 데이터는 계속 변합니다. 사용자가 새로고침해야만 최신 값을 볼 수 있다면 모니터링 화면으로서 의미가 떨어집니다.

실시간 업데이트 방법으로는 WebSocket이나 SSE도 있지만, 이번에는 5초 간격 폴링을 선택했습니다. 현재 규모에서는 수 초 지연을 허용할 수 있고, WebSocket이나 SSE를 붙이는 것보다 구현이 단순하고 서버 요청량도 감당할 만합니다. 임계값 감지와 알림 발송은 이미 서버가 에러 순간에 처리하므로(6~7편), 지연이 없어야 하는 쪽은 대시보드가 아닙니다.

그래서 세 조회 API를 5초마다 다시 요청해 화면을 갱신합니다. 감지 윈도우가 60초이므로 5초 간격이면 변화를 놓치지 않습니다.

폴링 옵션은 앱 전역 `QueryClient` 기본값으로 한 번만 설정합니다. `QueryClient`는 리렌더마다 새로 만들지 않도록 `useState`로 한 번만 생성합니다.

```tsx
// apps/frontend/app/providers.tsx
const [client] = useState(
  () =>
    new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: POLL_MS,
          refetchInterval: POLL_MS,
          refetchOnWindowFocus: false,
          retry: 1,
        },
      },
    }),
);
```

| 옵션 | 값 | 의미 |
|---|---|---|
| `refetchInterval` | 5초 | 5초마다 다시 가져옴 |
| `staleTime` | 5초 | 받은 지 5초 안 된 값은 다시 요청하지 않음 |
| `refetchOnWindowFocus` | false | 탭으로 돌아왔을 때 추가 요청하지 않음 |
| `retry` | 1 | 요청 실패 시 한 번만 재시도 |

`staleTime`을 인터벌과 같은 주기로 맞춘 이유는, 이 값이 0이면 패널을 토글해 쿼리가 다시 마운트될 때마다 즉시 refetch가 걸려 요청이 두 배가 되기 때문입니다. `retry`를 1로 둔 이유는, 5초 뒤 다음 폴링이 재시도하므로 실패한 요청에 오래 매달리지 않기 위해서입니다.

TanStack Query가 기본으로 하는 동작 두 가지는 따로 설정하지 않아도 됩니다. 마운트된 구독자가 없는 쿼리는 폴링하지 않고, 브라우저 탭이 백그라운드면 인터벌을 멈춥니다.

세 쿼리는 각자 독립된 인터벌로, 페이지 로드 직후 시작해 DB가 비어 있어도 `[]`를 받으며 계속 실행됩니다. 에러 발생 여부가 좌우하는 것은 응답 내용이지(예: `/status`는 최근 24시간 안에 에러가 있었던 서비스만 반환) 폴링 여부가 아닙니다.

`statsQuery`의 `queryKey`에는 조회 범위를 식별하는 값(`service`, `rangeMinutes`, `bucketSec`)만 넣고, 실제 `from`/`to`는 `queryFn`이 실행될 때마다 `Date.now()`로 계산합니다. 절대 시각을 키에 넣으면 렌더마다 키가 달라져 폴링 인터벌과 별개로 매 렌더 새 요청이 나가기 때문입니다.

```ts
// apps/frontend/lib/api/queries.ts
export function statsQuery({ service = null, rangeMinutes, bucketSec }: StatsQueryParams) {
  return {
    queryKey: ["stats", service, rangeMinutes, bucketSec ?? null] as const,
    queryFn: () =>
      getStats({ service, fromMs: Date.now() - rangeMinutes * 60_000, bucketSec }),
  };
}
```

같은 파라미터면 키가 같고, 조회 창은 폴링할 때마다 현재 시각을 따라 이동합니다. `queries.ts` 테스트 5개 중 세 개가 이 동작을 고정합니다.

폴링 주기 사이에 값이 어떻게 보이는지도 조정이 필요합니다. `/status`는 fetch 시점의 cooldown 잔여 TTL(초)만 주므로, 이 값을 그대로 표시하면 화면에서 숫자가 5초 단위로 끊겨 줄어듭니다.

```ts
// apps/frontend/lib/api/derive.ts
export function cooldownRemaining(
  ttlSecAtFetch: number | null,
  fetchedAtMs: number,
  nowMs: number,
): number | null {
  if (ttlSecAtFetch === null) return null;
  const elapsedSec = (nowMs - fetchedAtMs) / 1000;
  return Math.max(0, Math.ceil(ttlSecAtFetch - elapsedSec));
}
```

이 함수는 유닛 테스트 5개(비활성 `null`, 경과분 차감, 만료 시 0, 그리고 합계 헬퍼 2개)로 확인했고, 실제로 쓰는 패널은 다음 편입니다.

탭 하나가 만드는 요청은 세 쿼리 × 5초, 초당 0.6건이라 폴링 비용 자체는 크지 않습니다. 다만 사용자나 열린 탭이 많아지면 이야기가 달라집니다. `/alerts`는 시간 인덱스와 `LIMIT`으로 가볍고, `/status`는 24시간 `DISTINCT service` 스캔이 있어 중간, `/stats`는 매 폴링마다 조회 범위 전체를 `GROUP BY`하므로 가장 무겁습니다. 규모가 커지면 조회 주기를 API별로 다르게 두거나 서버 측 캐시를 짧게 거는 방법을 고려할 수 있고, 지금은 구현 복잡도를 늘리지 않는 쪽을 택했습니다. 이 판단은 README(이후 편)의 설계 근거에 남깁니다.

전체 데이터 계층은 vitest 유닛 테스트 23개(client 5, endpoints 6, queries 5, derive 5, store 2)와 전 워크스페이스 타입 체크, 린트, `next build`로 확인했습니다.

