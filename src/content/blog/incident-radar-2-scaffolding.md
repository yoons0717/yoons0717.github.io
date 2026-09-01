---

title: "[Incident Radar 2] NestJS·Next 스캐폴딩과 colima로 만든 로컬 인프라"

description: 백엔드·프론트 두 앱의 기본 골격을 세우고, 부팅할 때 환경변수를 검증하고, 맥에 Docker Desktop 없이 colima로 Postgres·Redis를 올린 과정.

pubDate: 2026-09-01

tags: [개발]

seriesOrder: 2

---

## 이번에 만든 것

backend는 NestJS, frontend는 Next.js로 구성합니다. 둘 다 1편에서 만든 `packages/shared`를 import합니다.

로컬 인프라는 Postgres와 Redis이고, `docker-compose`로 실행합니다.

```text
apps/
  backend/    # NestJS. 지금은 GET /health 스텁 하나
  frontend/   # Next.js. 스캐폴드 확인용 페이지 하나

packages/
  shared/     # 1편의 Zod 스키마. 두 앱이 import
```

아직 본격적인 기능은 없습니다.

이번 글의 범위는 세 가지입니다.

1. 두 앱을 정상적으로 기동하기
2. 환경변수가 잘못되면 시작 단계에서 기동을 중단하기
3. 종료할 때 열려 있는 커넥션을 정리하기

## NestJS 앱 세우기

### 모듈 트리와 DI

NestJS 앱은 모듈의 트리로 구성됩니다.

각 모듈은 컨트롤러(HTTP 요청·응답 처리)와 프로바이더(요청 자체를 알 필요가 없는 로직)를 묶고, 루트 `AppModule`이 그것들을 `imports`로 조립합니다.

클래스는 필요한 의존성을 직접 `new`하지 않고 생성자에 선언합니다. `@Injectable()`로 해당 클래스를 Nest의 DI 컨테이너가 관리하는 프로바이더로 등록합니다.

부팅 시 Nest는 등록된 의존성 관계를 해석해 필요한 객체들을 조립합니다. 기본적으로 프로바이더는 싱글턴 스코프로 관리됩니다.

이렇게 구성하면 테스트할 때 특정 의존성만 가짜 구현으로 교체하기 쉬워집니다.

### main.ts — 부팅 순서

```ts
async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableShutdownHooks();

  const config = app.get(ConfigService<Env, true>);

  const port = config.get("PORT", { infer: true });

  await app.listen(port);
}
```

먼저 `NestFactory.create()`로 모듈 트리를 조립하고, 종료 신호를 처리할 수 있도록 `enableShutdownHooks()`를 설정합니다.

그다음 검증을 통과한 설정에서 포트를 읽어 서버를 실행합니다.

### 환경변수 검증

환경변수가 빠졌거나 형식이 잘못되면, 해당 값을 실제로 사용하는 시점까지 오류가 드러나지 않을 수 있습니다.

대신 애플리케이션 시작 시점에 `process.env`를 Zod 스키마로 한 번 검증하고, 검증에 실패하면 기동 자체를 중단하도록 했습니다.

```ts
// apps/backend/src/config/env.schema.ts

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  ALERT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
});

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");

    throw new Error(`환경변수 검증 실패:\n${issues}`);
  }

  return parsed.data;
}
```

환경변수는 기본적으로 문자열로 전달됩니다.

`PORT`처럼 숫자로 사용해야 하는 값은 `z.coerce.number()`로 숫자로 변환하면서 검증합니다.

예를 들어 `PORT=abc`로 실행하면 애플리케이션 기동이 거부되고, 어떤 환경변수가 왜 잘못되었는지 목록으로 확인할 수 있습니다.

이 함수를 `ConfigModule`에 넘깁니다.

```ts
ConfigModule.forRoot({
  isGlobal: true,
  envFilePath: [".env", "../../.env"],
  validate: validateEnv,
});
```

`envFilePath`를 두 개 지정한 것은 앱별 `.env`와 모노레포 루트의 `.env`를 모두 사용할 수 있도록 하기 위해서입니다.

현재 설정에서는 앞에 지정한 경로부터 순서대로 확인합니다.

### 종료할 때 커넥션 정리

`enableShutdownHooks()`를 활성화하면 애플리케이션이 종료 신호를 받았을 때 Nest의 종료 라이프사이클 훅이 호출됩니다.

예를 들어 Redis 커넥션은 `onModuleDestroy`에서 `quit()`하도록 구성할 수 있습니다.

```ts
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client = new Redis(/* REDIS_URL */);

  async onModuleDestroy() {
    await this.client.quit();
  }
}
```

이렇게 하면 애플리케이션이 종료될 때 Redis 연결을 명시적으로 정리할 수 있습니다.

## Next.js 앱 세우기

### App Router

프론트엔드는 App Router로 구성했습니다.

App Router에서 컴포넌트는 기본적으로 서버 컴포넌트입니다. 서버 컴포넌트는 서버에서 렌더링되고, 해당 컴포넌트 자체의 JavaScript가 브라우저에 전달되지 않습니다.

상태, 이벤트 핸들러, 브라우저 API처럼 클라이언트에서 실행해야 하는 기능이 필요한 컴포넌트에만 `"use client"`를 붙입니다.

### 브라우저로 나가는 환경변수

`NEXT_PUBLIC_` 접두사가 붙은 값은 클라이언트에서 사용할 수 있도록 브라우저 번들에 포함됩니다.

따라서 사이트에 접속한 사용자는 해당 값을 확인할 수 있으며, 숨겨야 하는 정보에는 사용하면 안 됩니다.

API 주소처럼 공개되어도 되는 값만 이 접두사로 두고, 시크릿 키나 DB 접속정보 같은 값에는 사용하지 않습니다.

이 값은 클라이언트 번들에 포함되는 특성상 빌드 시점에 고정되므로, Docker 이미지를 빌드하는 방식이라면 build arg 등으로 값을 전달해야 합니다.

```ts
// apps/frontend/lib/config.ts

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";
```

### Tailwind v4와 shadcn/ui

Tailwind v4는 기본적인 설정 파일 없이도 사용할 수 있습니다.

`globals.css`에 다음 한 줄을 추가하고, PostCSS 플러그인을 등록했습니다.

```css
@import "tailwindcss";
```

```js
// apps/frontend/postcss.config.mjs

export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
```

shadcn/ui는 일반적인 컴포넌트 라이브러리처럼 패키지에서 컴포넌트를 import하는 방식이 아니라, 필요한 컴포넌트의 코드를 프로젝트에 생성하는 방식입니다.

예를 들어 `npx shadcn add card`를 실행하면 `components/ui/card.tsx`가 프로젝트에 생성되고, 이후에는 해당 코드를 프로젝트 코드로 직접 관리합니다.

### 공유 패키지 연결

모노레포 내부의 공유 패키지는 Next.js 빌드 과정에서 함께 트랜스파일하도록 지정했습니다.

```ts
// apps/frontend/next.config.ts

const nextConfig: NextConfig = {
  transpilePackages: ["@incident-radar/shared"],
};
```

## 로컬 인프라 — docker-compose + colima

Postgres와 Redis는 `docker-compose.yml`로 실행합니다.

```yaml
services:
  postgres:
    image: postgres:16-alpine

    environment:
      POSTGRES_USER: ir
      POSTGRES_PASSWORD: ir
      POSTGRES_DB: incident_radar

    ports: ["5432:5432"]

    volumes: ["pgdata:/var/lib/postgresql/data"]

    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ir -d incident_radar"]
      interval: 5s
      timeout: 3s
      retries: 10

  redis:
    image: redis:7-alpine

    ports: ["6379:6379"]

    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  pgdata:
```

`environment`의 세 값은 `.env`에 설정한 `DATABASE_URL`과 일치해야 합니다.

컨테이너는 리눅스 커널 기능을 사용하기 때문에 macOS에서는 리눅스 환경을 제공하는 별도의 VM 위에서 실행됩니다.

이 VM을 제공하는 도구로 Docker Desktop이 가장 널리 사용되지만, 이번 프로젝트에서는 colima를 선택했습니다.

* **라이선스** — Docker Desktop은 일정 규모 이상의 조직에서 상업적으로 사용하려면 유료 구독이 필요합니다. 지금은 개인 프로젝트라 해당되지 않지만, 라이선스 제약 없이 사용할 수 있는 colima를 선택했습니다. colima는 MIT 라이선스입니다.

* **가볍고 CLI로 다룬다** — colima는 `colima start` / `colima stop`으로 VM의 수명주기를 관리할 수 있습니다. GUI 없이 CLI 중심으로 사용할 수 있어 개발 환경을 명령어로 관리하기 편합니다.

* **docker CLI는 그대로** — colima는 Lima 기반의 VM에서 컨테이너 런타임을 실행하고, Docker CLI가 해당 환경을 사용할 수 있도록 연결합니다. 따라서 `docker`, `docker compose` 명령은 그대로 사용할 수 있고, 실제 컨테이너를 실행하는 VM만 colima가 제공합니다.

```bash
brew install colima docker docker-compose
colima start
docker compose up -d
```

CI에서도 Docker service container로 Postgres와 Redis를 실행합니다.

로컬과 CI 모두 컨테이너 기반으로 인프라를 구성하면, 적어도 DB와 Redis를 실행하는 방식은 같은 형태로 맞출 수 있습니다.

## 검증

다음 항목을 확인했습니다.

* `pnpm dev`로 backend가 `:3000`, frontend가 `:3001`에서 실행된다.

* `curl localhost:3000/health` → `{"status":"ok"}`

* `PORT=abc`로 backend를 실행하면 "환경변수 검증 실패"와 함께 기동이 거부된다.

* `pnpm --filter @incident-radar/frontend build` → 정적 페이지 생성

* `enableShutdownHooks()`를 활성화한 상태에서 종료 신호를 보내면 종료 라이프사이클 훅이 호출되고, 열려 있는 커넥션을 정리한 뒤 애플리케이션이 종료된다.
