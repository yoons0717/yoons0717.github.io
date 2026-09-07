import { getCollection, type CollectionEntry } from 'astro:content';

/** 날짜 최신순. 같은 날짜면 프로젝트별로 묶고, 그 안에서 시리즈 역순(최신 편이 위). */
export async function getSortedPosts(): Promise<CollectionEntry<'blog'>[]> {
	return (await getCollection('blog')).sort((a, b) => {
		const byDate = b.data.pubDate.valueOf() - a.data.pubDate.valueOf();
		if (byDate !== 0) return byDate;
		if (a.data.project !== b.data.project) return a.data.project < b.data.project ? -1 : 1;
		return (b.data.seriesOrder ?? 0) - (a.data.seriesOrder ?? 0);
	});
}

/** 한 프로젝트의 글을 시리즈 순서(개요가 위)로. */
export async function getProjectPosts(project: string): Promise<CollectionEntry<'blog'>[]> {
	return (await getCollection('blog'))
		.filter((p) => p.data.project === project)
		.sort((a, b) => (a.data.seriesOrder ?? 0) - (b.data.seriesOrder ?? 0));
}

export interface ProjectSummary {
	slug: string;
	count: number;
	latest: Date;
}

/** 사이드바용. 프로젝트별 글 수와 최신 글 날짜, 최신순 정렬. */
export async function getProjects(): Promise<ProjectSummary[]> {
	const byProject = new Map<string, ProjectSummary>();
	for (const post of await getCollection('blog')) {
		const s = byProject.get(post.data.project);
		if (!s) {
			byProject.set(post.data.project, {
				slug: post.data.project,
				count: 1,
				latest: post.data.pubDate,
			});
		} else {
			s.count++;
			if (post.data.pubDate > s.latest) s.latest = post.data.pubDate;
		}
	}
	return [...byProject.values()].sort((a, b) => b.latest.valueOf() - a.latest.valueOf());
}
