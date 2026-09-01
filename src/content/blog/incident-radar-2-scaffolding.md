---
title: "[Incident Radar 2] NestJS·Next 스캐폴딩과 colima로 만든 로컬 인프라"
description: 백엔드·프론트 두 앱의 기본 골격을 세우고, 부팅할 때 환경변수를 검증하고, 맥에 Docker Desktop 없이 colima로 Postgres·Redis를 올린 과정.
pubDate: 2026-09-01
tags: [개발]
seriesOrder: 2
---

## 이번에 만든 것

backend는 NestJS, frontend는 Next.js로 세웁니다. 둘 다 1편에서 만든 `packages/shared` 를
import 합니다. 로컬 인프라는 Postgres와 Redis이고, docker-compose로 올립니다.

```
apps/
  backend/    # NestJS. 지금은 GET /health 스텁 하나
  frontend/   # Next.js. 스캐폴드 확인용 페이지 하나
packages/
  shared/     # 1편의 Zod 스키마. 두 앱이 import
```

아직 기능은 없습니다. 이 글의 범위는 세 가지입니다. 두 앱을 기동하고, 환경변수가 잘못되면
시작 단계에서 중단하고, 종료할 때 커넥션을 정리합니다.

## NestJS 앱 세우기

### 모듈 트리와 DI

NestJS 앱은 모듈의 트리입니다. 각 모듈이 컨트롤러(HTTP 입출력)와 프로바이더(요청을 모르는 순수
로직)를 묶고, 루트 `AppModule` 이 그것들을 `imports` 로 조립합니다.

클래스는 필요한 의존성을 직접 `new` 하지 않고 생성자에 선언하고, `@Injectable()` 로 "이 클래스는
컨테이너가 관리한다"고 표시합니다. 부팅 시 Nest가 등록된 클래스들의 의존 그래프를 해석해 말단
의존성부터 조립하며, 기본은 싱글턴입니다. 이렇게 해두면 테스트에서 특정 의존성만 가짜 구현으로
바꿔 끼우기 쉽습니다.

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

모듈 트리를 조립하고(`NestFactory.create`), 종료 신호를 받도록 하고(`enableShutdownHooks`),
검증을 통과한 설정에서 포트를 읽어 listen 합니다.

### 환경변수 검증

환경변수가 빠졌거나 형식이 틀리면 실행 도중 그 값을 참조하는 지점에서야 오류가 드러납니다. 대신
시작 시점에 `process.env` 를 Zod 스키마로 한 번 검증하고, 통과하지 못하면 기동을 중단합니다.

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

환경변수는 모두 문자열로 전달됩니다. `PORT` 같은 숫자 값은 `z.coerce.number()` 로 변환하면서
검사합니다. `PORT=abc` 로 실행하면 기동이 거부되고, 어떤 변수가 왜 틀렸는지 목록으로 출력됩니다.

이 함수를 `ConfigModule` 에 넘깁니다.

```ts
ConfigModule.forRoot({
  isGlobal: true,
  envFilePath: [".env", "../../.env"],
  validate: validateEnv,
});
```

`envFilePath` 를 두 개 지정한 것은 앱별 `.env` 를 먼저 참조하고, 없으면 모노레포 루트 `.env` 를
읽도록 하기 위해서입니다.

### 종료할 때 커넥션 정리

`enableShutdownHooks()` 를 켜면 SIGTERM/SIGINT 수신 시 Nest가 각 프로바이더의
`onModuleDestroy` 를 호출합니다. 예를 들어 Redis 커넥션은 여기서 `quit()` 합니다.

```ts
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client = new Redis(/* REDIS_URL */);

  async onModuleDestroy() {
    await this.client.quit();
  }
}
```

## Next.js 앱 세우기

### App Router

프론트는 App Router로 구성했습니다. App Router에서 컴포넌트는 기본이 서버 컴포넌트이며, 서버에서
렌더링돼 HTML만 전달되고 브라우저로 가는 JS가 없습니다. 상호작용이 필요한 컴포넌트에만
`"use client"` 를 붙입니다.

### 브라우저로 나가는 환경변수

`NEXT_PUBLIC_` 접두사가 붙은 값은 빌드 시점에 브라우저 번들에 그대로 들어갑니다. 사이트에
접속한 누구나 소스에서 볼 수 있고, 숨길 방법이 없습니다. 그래서 API 주소처럼 공개돼도 되는 값만
이 접두사로 두고, 시크릿 키·DB 접속정보 같은 값에는 쓰지 않습니다. 번들에 값이 고정되므로
Docker 이미지로 빌드할 때는 build arg로 전달해야 합니다.

```ts
// apps/frontend/lib/config.ts
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";
```

### Tailwind v4와 shadcn/ui

Tailwind v4는 설정 파일이 거의 필요 없습니다. `globals.css` 에 `@import "tailwindcss";` 한
줄이고, `tailwind.config.js` 는 없으며, PostCSS 플러그인만 등록합니다.

```js
// apps/frontend/postcss.config.mjs
export default { plugins: { "@tailwindcss/postcss": {} } };
```

shadcn/ui는 컴포넌트 라이브러리가 아니라 코드 생성기입니다. `npx shadcn add card` 를 실행하면
`components/ui/card.tsx` 가 프로젝트 저장소로 복사되고, 그 뒤로는 내 코드로 관리합니다.

### 공유 패키지 연결

모노레포 공유 패키지는 Next 빌드가 함께 트랜스파일하도록 지정합니다.

```ts
// apps/frontend/next.config.ts
const nextConfig: NextConfig = {
  transpilePackages: ["@incident-radar/shared"],
};
```

## 로컬 인프라 — docker-compose + colima

Postgres와 Redis는 `docker-compose.yml` 로 실행합니다.

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

`environment` 의 세 값은 `.env` 의 `DATABASE_URL` 과 일치해야 합니다.

컨테이너는 리눅스 커널 기능이라 맥에서는 그대로 실행할 수 없습니다. 그래서 맥에서는 작은 리눅스
VM 위에서 컨테이너를 실행합니다. 이 VM을 제공하는 도구로 Docker Desktop이 가장 널리 쓰이지만,
여기서는 colima를 선택했습니다.

- **라이선스.** Docker Desktop은 일정 규모 이상 조직에서 상업적으로 쓰려면 유료 구독이
  필요합니다. 지금은 개인 프로젝트라 무료지만, 나중에 회사 환경으로 옮겼을 때 그대로 쓸 수 있는
  쪽을 골랐습니다. colima는 MIT 라이선스라 제약이 없습니다.
- **가볍고 CLI로 다룬다.** colima는 GUI나 상주 프로세스 없이 `colima start` / `colima stop`
  으로 VM 수명주기를 관리합니다. 스크립트나 CI에서 다루기 쉽습니다.
- **docker CLI는 그대로.** colima는 Lima 기반 VM에 Docker 데몬을 올리고 소켓만 노출합니다.
  `docker`, `docker compose` 명령은 바뀌지 않고, VM을 누가 제공하느냐만 다릅니다.

```bash
brew install colima docker docker-compose
colima start
docker compose up -d
```

CI도 Docker service container로 Postgres·Redis를 실행합니다. 로컬 환경을 Docker로 맞추면
로컬과 CI의 실행 환경이 같아집니다.

## 검증

- `pnpm dev` 로 backend가 `:3000`, frontend가 `:3001` 에서 실행된다
- `curl localhost:3000/health` → `{"status":"ok"}`
- `PORT=abc` 로 backend를 실행하면 "환경변수 검증 실패" 로 기동이 거부된다
- `pnpm --filter @incident-radar/frontend build` → 정적 페이지 생성
- `enableShutdownHooks()` 를 켜기 전에는 Ctrl+C 후에도 프로세스가 남을 수 있으나, 켜면 정상적으로 종료된다

