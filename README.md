# yoons0717.github.io

개인 개발 블로그. [Astro](https://astro.build/)로 만들었고 GitHub Actions로 GitHub Pages에 배포된다.

## 개발

```sh
npm install
npm run dev      # http://localhost:4321
npm run build    # dist/ 로 정적 빌드
npm run preview  # 빌드 결과 로컬 확인
```

## 글 쓰기

`src/content/blog/`에 `.md` 파일 추가:

```md
---
title: 글 제목
description: 한 줄 요약 (목록·RSS·SEO에 쓰임)
pubDate: 2026-08-31
tags: [태그1, 태그2]
---

본문...
```

`main`에 push하면 `.github/workflows/deploy.yml`이 빌드·배포한다.

## 스타일

- 전역 토큰·타이포그래피: `src/styles/global.css` (라이트/다크 CSS 변수)
- 컴포넌트별 스타일: 각 `.astro` 파일의 `<style>` 블록 (scoped)

## 댓글

giscus. 설정은 `src/consts.ts`의 `GISCUS`. Discussions + giscus 앱이 repo에 연결돼 있어야 한다.
