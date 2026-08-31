// Create a new blog post with today's date pre-filled.
//   npm run new -- "글 제목"
//   npm run new -- "글 제목" custom-slug
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [title, slugArg] = process.argv.slice(2);

if (!title) {
	console.error('제목을 넣어주세요:  npm run new -- "글 제목"');
	process.exit(1);
}

const slug =
	(slugArg ?? title)
		.toLowerCase()
		.trim()
		.replace(/[\s/_.]+/g, '-')
		.replace(/[^a-z0-9가-힣-]/g, '')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '') || 'post';

// local date as YYYY-MM-DD (sv-SE locale renders ISO format)
const today = new Date().toLocaleDateString('sv-SE');

const dir = join('src', 'content', 'blog');
const file = join(dir, `${slug}.md`);

if (existsSync(file)) {
	console.error(`이미 있음: ${file}`);
	process.exit(1);
}

const body = `---
title: ${title}
description:
pubDate: ${today}
tags: []
---

`;

mkdirSync(dir, { recursive: true });
writeFileSync(file, body);
console.log(`만들었어요: ${file}`);
console.log(`URL: /blog/${slug}/`);
