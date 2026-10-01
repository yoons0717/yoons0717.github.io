---
title: "[백엔드 개념 2] ORM과 TypeORM"
description: 코드의 객체와 DB의 행이 어떻게 다른지, ORM이 그 변환을 어떻게 대신해 주는지, TypeORM의 엔티티·리포지토리로 코드를 어떻게 쓰는지 정리합니다.
pubDate: 2026-09-08
tags: [데이터베이스]
project: backend
seriesOrder: 2
---

백엔드 코드에서 데이터베이스를 다룰 때, SQL을 직접 쓰는 대신 객체 메서드를 호출하고 그 호출을 SQL로 바꿔 주는 라이브러리를 쓸 수 있습니다. 이런 라이브러리를 ORM이라고 합니다.

객체와 행이 어떻게 다른지, ORM이 그 사이에서 무엇을 대신해 주는지, Node.js에서 쓰는 ORM에는 무엇이 있는지 보고, TypeORM의 엔티티·리포지토리로 코드를 어떻게 쓰는지 살펴봅니다.

## 객체와 테이블 행의 차이

사용자 한 명을 코드에서는 이런 객체로 다룹니다.

```ts
const user = {
  id: 1,
  email: "a@example.com",
  createdAt: new Date("2026-01-02T09:00:00Z"),
};
```

DB에는 같은 사용자가 `users` 테이블의 한 행으로 저장됩니다.

```text
 id | email         | created_at
----+---------------+------------------------
  1 | a@example.com | 2026-01-02 09:00:00+00
```

- 이름 — 코드는 `createdAt`, DB 열은 `created_at`입니다.
- 타입 — 코드는 `Date` 객체, DB는 `timestamptz` 같은 날짜·시간 타입입니다.
- 관계 — 코드에서는 `order.user.email`처럼 다른 객체를 따라갈 수 있지만, 행에는 `user_id` 같은 숫자만 있습니다.

그래서 DB에서 읽을 때는 행을 객체로, 저장할 때는 객체를 행으로 바꾸는 변환이 매번 필요합니다.

## SQL을 직접 쓸 때의 문제

ORM 없이 DB 드라이버만 쓰면 조회 코드가 이렇게 됩니다.

```ts
const { rows } = await pool.query(
  `SELECT id, email, created_at FROM users WHERE email = $1`,
  [email],
);
const user = rows[0]
  ? { id: rows[0].id, email: rows[0].email, createdAt: rows[0].created_at }
  : null;
```

- `rows`의 타입은 `any`입니다. `rows[0].emial`로 오타를 내도 실행 전까지 모릅니다.
- SQL이 문자열이라 편집기가 테이블·열 이름을 검사하지 못합니다.
- 열 이름과 속성 이름 매핑을 매번 손으로 씁니다.
- 이 변환 코드가 테이블마다, 쿼리마다 반복됩니다.

> 💡 **여기까지 정리하면**
>
> - 같은 데이터라도 코드의 객체와 DB의 행은 이름·타입·관계 표현이 다릅니다.
> - 그 사이 변환을 직접 짜면 타입 안전성이 없고 코드가 반복됩니다.

## ORM이란

**ORM**(Object-Relational Mapping)은 테이블을 클래스에, 행을 그 클래스의 객체에 대응시키고, 객체를 다루는 메서드 호출을 SQL로 번역해 주는 라이브러리입니다.

`repo.save(user)` 한 줄이 `INSERT` 문으로, `repo.find(...)`가 `SELECT` 문으로 바뀝니다. 결과 행은 다시 객체로 변환돼 돌아옵니다. 열 이름과 속성 이름 매핑, 값 바인딩을 ORM이 맡습니다.

이 일에는 타입이 필요하지 않으므로 ORM은 JavaScript에서도 씁니다. TypeScript와 함께 쓰면 속성 이름과 값의 타입까지 컴파일 단계에서 검사받을 수 있습니다.

## Node.js의 ORM

Node.js에서 많이 쓰는 ORM은 다음과 같습니다.

| ORM | 모델 정의 방식 | 특징 |
|---|---|---|
| Sequelize | `sequelize.define()`으로 모델 정의 | JavaScript용으로 시작해 오래 쓰여 온 ORM. TypeScript 타입은 나중에 추가됨 |
| TypeORM | 클래스와 데코레이터로 엔티티 정의 | TypeScript를 전제로 설계됨. NestJS와 함께 자주 쓰임 |
| Prisma | 별도 스키마 파일(`schema.prisma`)에 모델 정의 | 스키마에서 타입이 붙은 클라이언트 코드를 생성 |

다른 언어에도 같은 역할의 ORM이 있습니다. Java의 Hibernate, Python의 Django ORM, Ruby on Rails의 Active Record가 대표적입니다.

같은 `users` 테이블을 Sequelize로 다루면 이렇습니다. JavaScript 코드이고, 타입 선언은 없습니다.

```js
const User = sequelize.define("User", {
  email: { type: DataTypes.TEXT, allowNull: false },
}, { tableName: "users", underscored: true, updatedAt: false });

await User.create({ email: "c@example.com" });
await User.findAll({ where: { email }, order: [["createdAt", "DESC"]] });
```

- `underscored: true`로 속성 `createdAt`을 열 `created_at`에 연결합니다.
- `id`와 `createdAt`은 따로 적지 않아도 Sequelize가 기본으로 추가합니다. `updatedAt: false`는 이 테이블에 `updated_at` 열이 없어서 끈 것입니다.

정의하는 방법은 달라도, 모델을 정의하고 메서드를 호출하면 SQL이 만들어진다는 구조는 같습니다. 아래에서는 **TypeORM**으로 엔티티·리포지토리·데이터소스를 살펴봅니다.

## 엔티티

**엔티티**는 테이블 하나에 대응하는 클래스입니다. 속성이 어떤 열과 연결되는지는 데코레이터로 적습니다.

```ts
@Entity("users")
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("text")
  email!: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
```

- `@Entity("users")` — 이 클래스는 `users` 테이블에 대응합니다.
- `@Column("text") email` — `email` 속성은 `text` 열입니다. 이름이 같으면 그대로 씁니다.
- `@CreateDateColumn({ name: "created_at" })` — 속성은 `createdAt`, 열은 `created_at`. 이름이 다르면 `name`으로 지정합니다.

## 리포지토리

**리포지토리**는 엔티티 하나에 대한 조회·저장 메서드 모음입니다.

```ts
const repo = dataSource.getRepository(User);

// INSERT INTO "users"("email", "created_at") VALUES ($1, DEFAULT) RETURNING "id", "created_at"
await repo.save(repo.create({ email: "c@example.com" }));

// SELECT ... FROM "users" "User" WHERE "User"."email" = $1 ORDER BY "User"."created_at" DESC
await repo.find({
  where: { email },
  order: { createdAt: "DESC" },
});
```

- `repo.create(...)`는 객체를 만들고, `repo.save(...)`가 `INSERT`를 보낸 뒤 DB가 채운 값을 되받아 객체에 넣습니다.
- `find`의 조건과 정렬은 `SELECT` 문으로 번역됩니다. `email` 값은 SQL에 섞이지 않고 `$1`로 따로 전달돼(파라미터 바인딩) SQL 인젝션을 피합니다.
- 조건과 정렬에는 열 이름(`created_at`)이 아니라 속성 이름(`createdAt`)을 씁니다. 속성 이름을 잘못 쓰면 타입 검사에서 걸리고, TypeORM이 열 이름으로 바꿔 번역합니다.

조건이 복잡해지면 `createQueryBuilder`로 SQL에 가까운 체인을 쓸 수 있습니다. 다만 조건을 `"u.email = :email"` 같은 문자열로 적기 때문에, 이 부분은 타입 검사를 받지 못합니다.

## 데이터소스

**데이터소스**는 연결 정보(연결 문자열)와 엔티티 목록을 담은 객체입니다. 애플리케이션이 시작할 때 이 객체로 DB에 연결하고, 리포지토리도 이 객체에서 얻습니다.

> 💡 **여기까지 정리하면**
>
> - 엔티티가 클래스↔테이블, 속성↔열 매핑을 정의합니다.
> - 리포지토리 메서드 호출이 SQL로 번역되고, 결과 행이 객체로 돌아옵니다.
> - 데이터소스가 연결 정보와 엔티티 목록을 담고 있습니다.

## 스키마는 누가 바꾸나?

엔티티는 테이블 구조도 정의합니다. TypeORM에는 엔티티를 보고 실제 DB 스키마를 자동으로 맞추는 `synchronize: true` 옵션이 있습니다. 편하지만 열 삭제·재생성으로 데이터가 유실될 수 있고 변경 이력이 남지 않습니다.

그래서 실무에서는 대개 이 옵션을 끄고, 스키마 변경을 **마이그레이션(migration)** 파일로 관리합니다. 엔티티를 고친 뒤 TypeORM CLI의 `migration:generate`로 엔티티와 실제 DB를 비교해 변경 SQL이 담긴 마이그레이션 파일을 만들고, 검토한 뒤 적용합니다. 마이그레이션 파일 위치는 데이터소스 설정에 함께 적습니다.

## 언제 ORM을 쓰고 언제 SQL을 직접 쓸까?

ORM은 한 테이블에서 조건 몇 개로 거르고 정렬하는 조회나, 객체 하나를 저장·수정·삭제하는 작업에서 반복을 줄여 줍니다.

여러 행을 묶어 집계하거나(`GROUP BY`, 윈도우 함수) DB 고유 함수를 쓰는 쿼리는 SQL로 쓰는 편이 명확합니다. 쿼리 빌더에 SQL 조각을 직접 넣거나, 원시 SQL을 실행하고 결과를 객체로 바꾸지 않고 그대로 받습니다. ORM은 이렇게 SQL을 직접 실행하는 방법도 제공합니다.

## 정리

- 코드의 객체와 DB의 행은 이름·타입·관계 표현이 달라 변환이 필요합니다. 이 변환을 직접 짜면 타입 안전성이 없고 코드가 반복됩니다.
- ORM은 클래스↔테이블 매핑을 정의하고, 메서드 호출을 SQL로 번역해 이 반복을 없앱니다.
- ORM은 JavaScript에서도 쓰고, TypeScript와 함께 쓰면 타입 검사까지 받습니다. Node.js에서는 Sequelize, TypeORM, Prisma가 많이 쓰입니다.
- TypeORM은 엔티티(매핑), 리포지토리(조회·저장), 데이터소스(연결)로 구성됩니다.
- 스키마 변경은 `synchronize`에 맡기지 않고 마이그레이션으로 관리하는 편이 안전합니다.
- 무거운 집계 쿼리는 SQL을 직접 씁니다. ORM도 SQL을 직접 실행하는 방법을 제공합니다.
