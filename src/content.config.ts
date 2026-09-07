import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
	// Load Markdown and MDX files in the `src/content/blog/` directory.
	loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
	// Type-check frontmatter using a schema
	schema: z.object({
		title: z.string(),
		description: z.string(),
		// Transform string to Date object
		pubDate: z.coerce.date(),
		updatedDate: z.coerce.date().optional(),
		tags: z.array(z.string()).default([]),
		// 글이 속한 프로젝트. 사이드바 카테고리와 프로젝트별 목록의 기준.
		project: z.string().default('incident-radar'),
		// 프로젝트 안에서의 글 순서. 이 값이 있는 글끼리 이전/다음 링크로 이어진다.
		seriesOrder: z.number().optional(),
	}),
});

export const collections = { blog };
