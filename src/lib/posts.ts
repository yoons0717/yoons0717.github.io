import { getCollection, type CollectionEntry } from 'astro:content';

/** 날짜 최신순. 같은 날짜면 시리즈 역순(최신 편이 위, 개요가 아래). */
export async function getSortedPosts(): Promise<CollectionEntry<'blog'>[]> {
	return (await getCollection('blog')).sort((a, b) => {
		const byDate = b.data.pubDate.valueOf() - a.data.pubDate.valueOf();
		if (byDate !== 0) return byDate;
		return (b.data.seriesOrder ?? 0) - (a.data.seriesOrder ?? 0);
	});
}
