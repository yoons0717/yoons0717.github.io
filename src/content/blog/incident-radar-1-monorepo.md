---

title: "[Incident Radar 1] 모노레포와 공유 스키마로 프론트·백 계약 묶기"

description: 앱 3개를 한 레포에 담고 Zod 스키마 하나로 프론트·백 API 계약을 묶은 과정. pnpm workspace, Turborepo, tsup dual build.

pubDate: 2026-08-31

tags: [개발]

seriesOrder: 1

---

## 왜 모노레포인가

만들 것은 사실상 앱 3개입니다.

* `apps/backend` — NestJS
* `apps/frontend` — Next.js
* `packages/shared` — 두 앱이 함께 사용하는 Zod 스키마 + 타입

레포를 셋으로 나눌 수도 있습니다. 그러면 `shared` 스키마를 수정할 때마다 npm에 배포하고, 백엔드·프론트엔드에서 버전을 올려 다시 받아야 합니다.

각 서비스의 배포 주기가 서로 다른 큰 팀에서는 이런 방식이 맞을 수 있습니다. 하지만 혼자 개발하는 현재 규모에서는 이 왕복 과정이 불필요한 오버헤드입니다.

모노레포로 구성하면 한 저장소 안에 `apps/`, `packages/`로 나눠 담을 수 있습니다. `pnpm install` 한 번, CI 한 번이면 됩니다. `shared`를 수정하면 백엔드와 프론트엔드가 바로 그 변경을 사용할 수 있습니다. npm을 거치지 않고 로컬 패키지가 워크스페이스 의존성으로 연결되기 때문입니다.

**모노레포에서 역할을 나누면 다음과 같습니다.**

* **pnpm workspace** — 패키지를 어떻게 연결할지
* **Turborepo** — 여러 패키지의 태스크를 어떤 순서와 방식으로 실행할지

## pnpm workspace 설정

루트에 `pnpm-workspace.yaml` 하나를 두면 됩니다.

```yaml
packages:
  - "apps/*"
  - "packages/*"
  - "tools"
```

이제 pnpm은 `apps/backend`, `apps/frontend`, `packages/shared`를 각각 `package.json`을 가진 독립 패키지로 인식합니다.

그래서 다음과 같은 구성이 가능합니다.

* 루트에서 `pnpm install` 한 번이면 세 패키지의 의존성이 모두 설치되고, 공유 가능한 의존성은 중복 설치를 줄일 수 있습니다.

* 백엔드가 `@incident-radar/shared`를 의존하면(`"@incident-radar/shared": "workspace:*"`), pnpm은 npm 레지스트리에서 패키지를 받는 대신 현재 워크스페이스의 `packages/shared` 패키지를 연결합니다.

`workspace:*`는 버전 자리에 `^1.2.0` 같은 일반적인 버전 범위 대신 사용하는 값입니다.

"이 의존성은 npm에서 받는 패키지가 아니라 현재 워크스페이스 안의 패키지"라는 의미이고, `*`는 워크스페이스의 로컬 패키지를 그대로 참조한다는 뜻입니다.

pnpm은 `node_modules/@incident-radar/shared`에서 실제 워크스페이스 패키지를 참조할 수 있도록 연결하기 때문에, `shared` 패키지의 변경 사항을 다른 앱에서 함께 사용할 수 있습니다. 배포 가능한 패키지로 패킹할 때는 `workspace:` 프로토콜이 실제 버전 범위로 변환됩니다.

## Turborepo — 태스크 오케스트레이션

루트 `package.json`의 스크립트는 각 패키지의 명령을 직접 실행하지 않고 Turbo에 위임합니다.

```json
{
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test"
  }
}
```

`turbo.json`은 여러 패키지에서 실행되는 태스크의 의존 관계와 실행 방식을 정의합니다.

```json
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**", "!.next/cache/**"]
    },
    "dev": { "cache": false, "persistent": true },
    "lint": { "dependsOn": ["^build"] },
    "typecheck": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["^build"] }
  }
}
```

`"dependsOn": ["^build"]`는 "현재 패키지의 태스크를 실행하기 전에, 내가 의존하는 패키지들(`^`)의 `build`를 먼저 실행하라"는 뜻입니다.

백엔드가 `shared`를 의존하므로 `turbo run build`를 실행하면 `shared`를 먼저 빌드한 뒤 백엔드를 빌드합니다. 프론트엔드 역시 같은 방식입니다.

`lint`·`typecheck`·`test`도 필요한 의존 패키지의 빌드 산출물이 준비된 상태에서 실행하도록 같은 의존 순서를 따릅니다.

`outputs`를 지정하면 Turbo가 빌드 결과물을 캐시합니다. 입력인 소스나 의존성이 변경되지 않았다면 다시 빌드하지 않고 캐시된 결과를 재사용합니다. 특히 CI에서 실행 시간을 줄이는 데 도움이 됩니다.

`dev`는 `cache: false`, `persistent: true`로 설정했습니다. 개발 서버는 캐시할 대상이 아니고, 한 번 실행하면 계속 살아 있는 프로세스이기 때문입니다.

`turbo run dev` 하나로 `shared`의 watch 빌드와 백엔드(`:3000`), 프론트엔드(`:3001`)를 동시에 실행합니다.

## 버전 고정

개발 환경과 CI 환경에서 사용하는 버전 차이로 문제가 생기지 않도록 Node.js와 pnpm 버전을 고정했습니다.

* `.nvmrc` — `20` (`nvm use`가 읽음)
* 루트 `package.json`의 `"engines": { "node": ">=20" }`
* 루트 `package.json`의 `"packageManager": "pnpm@9.15.0"` — 팀·CI에서 같은 pnpm 버전을 사용하도록 지정

## packages/shared — 요청·응답 형태를 한 곳에 정의한다

`packages/shared/src/schemas.ts` 파일에 요청과 응답의 형태를 Zod 스키마로 정의하고, 백엔드와 프론트엔드가 이 파일을 함께 import합니다.

TypeScript 타입은 별도로 작성하지 않고 스키마에서 파생합니다.

```ts
import { z } from "zod";

export const ErrorLogInput = z.object({
  service: z.string().min(1).max(100),
  message: z.string().min(1).max(8192),
});

export type ErrorLogInput = z.infer<typeof ErrorLogInput>;

export const ErrorLog = z.object({
  id: z.string().uuid(),
  service: z.string().min(1).max(100),
  message: z.string(),
  createdAt: z.string().datetime(),
});

export type ErrorLog = z.infer<typeof ErrorLog>;
```

Zod 스키마는 런타임에 존재하는 객체입니다.

반면 `z.infer<typeof ErrorLog>`는 해당 스키마를 기준으로 TypeScript 타입을 컴파일 타임에 도출합니다.

위 `ErrorLog`에서는 다음과 같은 타입이 만들어집니다.

```ts
{
  id: string;
  service: string;
  message: string;
  createdAt: string;
}
```

스키마 하나만 수정하면 타입도 함께 변경되므로, 같은 구조의 타입을 별도로 수기로 관리할 필요가 없습니다.

### 타입이 아니라 검증 로직을 공유한다

타입만 공유하면 컴파일 타임에만 의미가 있습니다. TypeScript 타입은 런타임에는 존재하지 않기 때문입니다.

Zod 스키마를 공유하면 타입뿐 아니라 런타임 검증 규칙도 함께 공유할 수 있습니다.

* 백엔드는 이 스키마로 들어오는 요청을 검증합니다. (`POST /errors`의 Zod 파이프는 다음 편에서 작성할 예정입니다.)
* 프론트엔드는 받은 응답을 이 스키마로 `parse`하도록 구성합니다. (프론트 화면은 아직 연결하지 않았고, API 계약만 먼저 정의해 둡니다.)

즉, 백엔드는 받은 요청을 검증하고 프론트엔드는 받은 응답을 검증합니다.

한쪽에서 필드를 변경하려면 `shared`의 스키마도 함께 변경해야 합니다. 스키마가 변경되는 순간 다른 쪽에서 타입 에러나 런타임 `parse` 실패가 발생할 수 있습니다.

이것이 프론트엔드와 백엔드를 하나의 "계약"으로 묶는다는 말의 실체입니다.

타입을 공유하더라도 시스템 경계에서 `parse`가 필요한 이유는, 실행 중인 서버가 컴파일러가 확인하지 못한 데이터를 반환할 수 있기 때문입니다.

예를 들어 스키마 드리프트, 직렬화 버그, 혹은 중간 프록시가 에러 페이지 HTML을 응답으로 반환하는 경우가 있습니다.

### 판별 유니온으로 잘못된 조합 막기

알림 이력에는 "발송 성공"과 "재시도 소진 후 실패"처럼 서로 다른 정보를 가지는 경우가 있습니다.

이를 `z.discriminatedUnion`으로 표현합니다.

```ts
const AlertDispatched = z.object({
  id: z.string().uuid(),
  service: z.string().min(1).max(100),
  status: z.literal("dispatched"),
  at: z.string().datetime(),
  count: z.number().int().nonnegative(),
  threshold: z.number().int().positive(),
  windowMs: z.number().int().positive(),
});

const AlertFailed = z.object({
  id: z.string().uuid(),
  service: z.string().min(1).max(100),
  status: z.literal("failed"),
  at: z.string().datetime(),
  attempts: z.number().int().positive(),
  error: z.string(),
});

export const Alert = z.discriminatedUnion("status", [
  AlertDispatched,
  AlertFailed,
]);

export type Alert = z.infer<typeof Alert>;
```

`status: "dispatched"`라면 `count`와 `threshold`가 필수이고, `status: "failed"`라면 `attempts`와 `error`가 필수입니다.

예를 들어 `status`는 `"dispatched"`인데 `count`가 빠진 객체는 `Alert.parse()`에서 거부됩니다.

## tsup으로 dual build

백엔드(NestJS)와 프론트엔드(Next.js)가 `shared` 패키지를 소비하는 모듈 환경이 다를 수 있기 때문에, `shared`는 ESM과 CJS 형식으로 모두 빌드해 내보냅니다.

CJS는 `require()` / `module.exports`를 사용하고, ESM은 `import` / `export`를 사용합니다. 문법뿐 아니라 모듈을 해석하고 로드하는 방식에도 차이가 있습니다.

`shared`는 양쪽 환경에서 사용할 수 있어야 하므로 두 형식으로 빌드합니다. `tsup` 설정 하나로 처리할 수 있습니다.

```ts
// packages/shared/tsup.config.ts

import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
});
```

tsup은 esbuild 기반이라 빌드가 빠르게 끝납니다.

`dts: true`를 설정하면 `.d.ts` 파일도 생성되므로, 패키지를 사용하는 쪽에서 타입 체크와 자동완성을 사용할 수 있습니다.

`package.json`의 `exports`는 소비하는 방식에 따라 서로 다른 진입점으로 연결합니다.

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  }
}
```

`require`로 들어오면 CJS 파일을, `import`로 들어오면 ESM 파일을 사용하도록 조건부로 진입점을 나눕니다.

`dev` 스크립트는 `tsup --watch`로 두고, 최초 빌드 순서는 Turbo의 `^build` 의존성이 처리합니다.

## 검증

아직 스캐폴딩 단계라 본격적인 애플리케이션 테스트는 많지 않습니다.

우선 아래 명령이 모두 에러 없이 통과하는지 확인합니다.

```bash
pnpm install                    # 세 패키지 의존성 설치 성공
pnpm turbo run build --dry      # 태스크 그래프 출력 (shared → backend/frontend 순서 확인)
pnpm turbo run lint             # 무에러
pnpm format:check               # 포맷 통과
```

`packages/shared`는 단순한 껍데기가 아니라 이미 실제 API 계약에 사용되는 스키마를 가지고 있으므로, 스키마 자체에 대한 테스트도 붙였습니다.

Vitest로 "계약이 의도한 만큼 데이터를 제한하고 있는지"를 검증합니다.

```ts
// packages/shared/src/schemas.test.ts

it("message가 상한(8192)을 넘으면 거부한다", () => {
  const tooBig = {
    service: "checkout",
    message: "a".repeat(8193),
  };

  expect(ErrorLogInput.safeParse(tooBig).success).toBe(false);
});

it("dispatched인데 count가 빠지면 거부한다", () => {
  // 나머지 필드는 전부 유효하고 count만 없음
  // → 판별 유니온이 거부해야 함
  const bad = {
    id: "00000000-0000-0000-0000-000000000003",
    service: "checkout",
    status: "dispatched",
    at: "2026-08-30T14:32:07.000Z",
    threshold: 10,
    windowMs: 60000,
  };

  expect(Alert.safeParse(bad).success).toBe(false);
});
```

최종적으로 `shared` 패키지를 직접 대상으로도 빌드와 타입 체크, 테스트를 확인했습니다.

```bash
pnpm --filter @incident-radar/shared build      
pnpm --filter @incident-radar/shared typecheck  # tsc --noEmit
pnpm --filter @incident-radar/shared test       # 6 passed
```
