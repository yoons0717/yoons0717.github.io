---
title: "[Incident Radar] 모노레포와 공유 스키마로 프론트·백 계약 묶기"
description: 앱 3개를 한 레포에 담고 Zod 스키마 하나로 프론트·백 API 계약을 묶은 과정. pnpm workspace, Turborepo, tsup dual build.
pubDate: 2026-08-31
tags: [개발]
---


## 왜 모노레포인가

만들 것은 사실상 앱 3개입니다.

- `apps/backend` — NestJS
- `apps/frontend` — Next.js
- `packages/shared` — 두 앱이 함께 쓰는 Zod 스키마 + 타입

레포를 셋으로 나눌 수도 있습니다. 그러면 `shared` 스키마를 고칠 때마다 npm에 배포하고,
백엔드·프론트에서 버전을 올려 받아야 합니다. 배포 주기가 서로 다른 큰 팀에는 맞는 방식이지만,
혼자 개발하는 이 규모에서는 그 왕복이 불필요한 오버헤드입니다.

모노레포로 하면 한 저장소에 `apps/`, `packages/` 로 나눠 담습니다. `pnpm install` 한 번,
CI 한 번. `shared` 를 고치면 백엔드·프론트가 바로 그 변경을 봅니다. npm을 거치지 않고 로컬
폴더가 심볼릭 링크로 연결돼 있기 때문입니다.

**모노레포**

- **pnpm workspace** — 패키지를 어떻게 연결할지
- **Turborepo** — 그 패키지들에서 명령을 어떤 순서로 돌릴지

## pnpm workspace 설정

루트에 `pnpm-workspace.yaml` 하나면 됩니다.

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

이제 pnpm은 `apps/backend`, `apps/frontend`, `packages/shared` 를 각각 `package.json` 을 가진
독립 패키지로 인식합니다. 그래서:

- 루트에서 `pnpm install` 한 번이면 세 패키지 의존성이 전부 설치되고, 중복은 한 곳에 공유됩니다.
- 백엔드가 `@incident-radar/shared` 를 의존하면(`"@incident-radar/shared": "workspace:*"`),
  pnpm이 npm에서 받는 대신 `packages/shared` 폴더를 심링크로 연결합니다.

`workspace:*` 는 버전 자리에 `^1.2.0` 대신 쓰는 값입니다. "이건 npm이 아니라 이 워크스페이스
안의 패키지"라는 표시고, `*` 는 버전을 안 따지고 로컬 걸 그대로 쓴다는 뜻입니다. pnpm이
`node_modules/@incident-radar/shared` 를 실제 폴더로 가는 심링크로 만들어서, `shared/src` 를
고치는 즉시 백엔드가 그 코드를 봅니다. 배포할 때는 pnpm이 이 값을 실제 버전으로 치환합니다.

## Turborepo — 태스크 오케스트레이션

루트 `package.json` 의 스크립트는 전부 Turbo에 위임합니다.

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

`turbo.json` 은 각 태스크의 의존 순서를 잡습니다.

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

`"dependsOn": ["^build"]` 는 "이 태스크를 돌리기 전에 내가 의존하는 패키지들(`^`)을 먼저
빌드하라"는 뜻입니다. 백엔드가 `shared` 를 의존하니 `turbo run build` 는 `shared` 를 먼저
빌드하고 백엔드를 빌드합니다. `lint`·`typecheck`·`test` 도 `shared` 의 빌드 산출물이 있어야
타입이 맞으니 같은 순서를 따릅니다.

`outputs` 를 지정하면 Turbo가 결과물을 캐시합니다. 입력(소스, 의존성)이 안 바뀌면 다시 빌드하지
않고 캐시를 재사용합니다. CI에서 특히 체감됩니다.

`dev` 는 `cache: false, persistent: true` 입니다. 캐시하지 않고, 계속 떠 있는 프로세스라는
표시입니다. `turbo run dev` 하나로 `shared`(watch 빌드)와 백엔드(:3000), 프론트(:3001)가
동시에 뜹니다.

## 버전 고정

- `.nvmrc` — `20` (한 줄. `nvm use` 가 읽음)
- 루트 `package.json` 의 `"engines": { "node": ">=20" }`
- 루트 `package.json` 의 `"packageManager": "pnpm@9.15.0"` (팀·CI가 같은 pnpm을 쓰게 강제)

## packages/shared — 요청·응답 형태를 한 파일에 정의한다

`packages/shared/src/schemas.ts` 파일 하나에 요청·응답이 어떻게 생겼는지를 Zod 스키마로 적어두고,
백엔드와 프론트가 이 파일을 함께 import 합니다. 타입은 스키마에서 파생합니다.

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

Zod 스키마는 런타임 객체(값)입니다. `z.infer<typeof ErrorLog>` 는 그 스키마가 통과시키는
데이터의 타입을 컴파일 타임에 뽑아냅니다. 위 `ErrorLog` 에서는
`{ id: string; service: string; message: string; createdAt: string }` 이 도출됩니다. 스키마
하나만 고치면 타입이 따라오니 수기 타입을 안 씁니다.

### 타입이 아니라 검증 로직을 공유한다

타입만 공유하면 컴파일 타임에만 의미가 있습니다. 런타임에는 타입이 사라집니다. Zod 스키마를
공유하면 런타임에 실제로 데이터를 검사합니다.

- 백엔드는 이 스키마로 들어오는 요청을 검증합니다. (`POST /errors` 의 Zod 파이프. 이건 다음에 작성할 예정)
- 프론트는 이 스키마로 받은 응답을 parse 하게 만듭니다. (프론트 화면은 아직 안 붙었고, 계약만 먼저 세워둡니다.)

그래서 백엔드는 받은 요청을, 프론트는 받은 응답을 각자 다시 parse 합니다. 한쪽이 필드를 바꾸면
`shared` 스키마를 고쳐야 하고, 고치는 순간 다른 쪽에서 타입 에러나 parse 실패로 드러납니다.
이게 "계약"으로 묶는다는 말의 실체입니다.

타입을 공유해도 경계에서 parse가 필요한 이유는, 구동 중인 서버가 컴파일러는 못 본 걸 반환할 수
있기 때문입니다. 스키마 드리프트, 직렬화 버그, 중간 프록시가 끼워넣은 에러 HTML 같은 것들입니다.

### 판별 유니온으로 잘못된 조합 막기

알림 이력은 "발송 성공"과 "재시도 소진 후 실패"가 서로 다른 필드를 가집니다.
`z.discriminatedUnion` 으로 표현합니다.

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

export const Alert = z.discriminatedUnion("status", [AlertDispatched, AlertFailed]);
export type Alert = z.infer<typeof Alert>;
```

`status: "dispatched"` 면 `count`·`threshold` 가 필수, `"failed"` 면 `attempts`·`error` 가
필수입니다. `status` 는 있는데 `count` 가 빠진 객체는 `Alert.parse()` 에서 거부됩니다.

## tsup 으로 dual build

백엔드(NestJS)는 CommonJS로, 프론트(Next.js)는 ESM으로 모듈을 로드합니다. CJS는
`require()` / `module.exports`, ESM은 `import` / `export` 로, 문법뿐 아니라 로딩 방식도
다릅니다. `shared` 는 양쪽에서 쓰이니 두 벌로 빌드해서 내보내야 합니다. `tsup` 설정 하나로
됩니다.

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

esbuild 기반이라 빌드는 거의 즉시 끝납니다. `dts: true` 로 `.d.ts` 가 생성되니 소비하는 쪽에서
자동완성·타입체크가 됩니다. `package.json` 의 `exports` 가 진입점을 나눕니다. `require` 로
들어오면 CJS 파일, `import` 로 들어오면 ESM 파일로 라우팅됩니다.

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

`dev` 스크립트는 `tsup --watch` 로 두고, 최초 빌드 순서는 Turbo의 `^build` 가 처리합니다.

## 검증

아직 스캐폴딩 단계라 본격적인 테스트는 없고, 아래 명령이 모두 에러 없이 통과하면 됩니다.

```bash
pnpm install                    # 세 패키지 의존성 설치 성공
pnpm turbo run build --dry      # 태스크 그래프 출력 (shared → backend/frontend 순서 확인)
pnpm turbo run lint             # 무에러
pnpm format:check               # 포맷 통과
```

`packages/shared` 는 껍데기가 아니라 이미 스키마가 있으니 실제 테스트를 붙였습니다. Vitest로
스키마 자체를 검증합니다. 계약이 의도한 만큼 좁은지 보는 겁니다.

```ts
// packages/shared/src/schemas.test.ts
it("message 가 상한(8192)을 넘으면 거부한다", () => {
  const tooBig = { service: "checkout", message: "a".repeat(8193) };
  expect(ErrorLogInput.safeParse(tooBig).success).toBe(false);
});

it("dispatched 인데 count 가 빠지면 거부한다", () => {
  // 나머지 필드는 전부 유효, count 만 없음 → 판별 유니온이 거부해야 함
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

```bash
pnpm --filter @incident-radar/shared build      # ESM 1.6KB + CJS 3.3KB + d.ts 5.4KB
pnpm --filter @incident-radar/shared typecheck  # tsc --noEmit
pnpm --filter @incident-radar/shared test       # 6 passed
```

## 겪은 함정

- 처음엔 빌드 없이 `src` 를 직접 노출하는 방식으로 하려다 되돌렸습니다. 빌드 단계가 하나
  줄어드는 대신, 백엔드의 `tsc`·`nest build`·Jest가 `node_modules` 안의 `.ts` 를 컴파일하도록
  설정해야 합니다(`transformIgnorePatterns` 등). 설정이 더 늘어서, tsup 빌드가 훨씬 깔끔했습니다.
- `.gitignore` 는 처음에 제대로 넣는 게 낫습니다. 이미 추적 중인 파일은 나중에 패턴을 추가해도
  안 빠지고 `git rm --cached` 를 따로 해야 합니다. `node_modules`, `dist`, `.next`, `.env`,
  `coverage` 는 첫 커밋 전에.

