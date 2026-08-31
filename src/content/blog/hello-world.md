---
title: 블로그 시작
description: Astro로 직접 만든 개발 블로그를 열었다.
pubDate: 2026-08-31
tags: [잡담, blog]
---

개발하면서 배운 것들을 정리하려고 블로그를 열었다.

처음엔 Jekyll + Chirpy 테마로 만들었는데, 테마 구조에 얹혀가는 것보다 직접 구성해보고 싶어서 [Astro](https://astro.build/)로 다시 만들었다.

- 글은 `src/content/blog/`에 마크다운으로 추가한다 (`YYYY 형식의 파일명.md`)
- frontmatter에 `title`, `description`, `pubDate`, `tags`
- `npm run dev`로 로컬에서 확인하고 `git push` 하면 GitHub Actions가 빌드해서 배포한다

스타일은 컴포넌트별 scoped CSS와 `src/styles/global.css` 하나로 관리한다. 천천히 손볼 예정.
