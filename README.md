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

```sh
npm run new -- "글 제목"              # src/content/blog/<slug>.md 생성, pubDate 오늘로
npm run new -- "글 제목" custom-slug  # 슬러그 직접 지정
```

생성되는 frontmatter:

```md
---
title: 글 제목
description:            # 한 줄 요약 (목록·RSS·SEO). 채워넣기
pubDate: 2026-08-31     # 자동
tags: []
---

본문...
```

`updatedDate: 2026-09-05`를 넣으면 글에 수정일도 표시된다.

`main`에 push하면 `.github/workflows/deploy.yml`이 빌드·배포한다 (1~2분).

## 스타일

- 전역 토큰·타이포그래피: `src/styles/global.css` (라이트/다크 CSS 변수)
- 컴포넌트별 스타일: 각 `.astro` 파일의 `<style>` 블록 (scoped)

## 댓글

giscus. 설정은 `src/consts.ts`의 `GISCUS`. Discussions + giscus 앱이 repo에 연결돼 있어야 한다.
