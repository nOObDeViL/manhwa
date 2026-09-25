/** AniList GraphQL (free, no key, CORS-enabled). Manhwa = MANGA with countryOfOrigin KR. */
const ENDPOINT = 'https://graphql.anilist.co';

export interface Manhwa {
  id: number;
  title: { romaji?: string; english?: string; native?: string; userPreferred?: string };
  coverImage: { extraLarge?: string; large?: string; color?: string };
  bannerImage?: string;
  description?: string;
  genres: string[];
  averageScore?: number;
  popularity?: number;
  status?: string;
  chapters?: number;
  siteUrl?: string;
  startDate?: { year?: number };
}

export const GENRES = [
  'Action',
  'Adventure',
  'Comedy',
  'Drama',
  'Fantasy',
  'Horror',
  'Mystery',
  'Psychological',
  'Romance',
  'Sci-Fi',
  'Slice of Life',
  'Sports',
  'Supernatural',
  'Thriller',
];

export const SORTS = [
  { value: 'TRENDING_DESC', label: 'Trending' },
  { value: 'POPULARITY_DESC', label: 'Popular' },
  { value: 'SCORE_DESC', label: 'Top rated' },
  { value: 'START_DATE_DESC', label: 'Newest' },
] as const;
export type SortKey = (typeof SORTS)[number]['value'];

const FIELDS = `
  id
  title { romaji english native userPreferred }
  coverImage { extraLarge large color }
  bannerImage
  description(asHtml: false)
  genres
  averageScore
  popularity
  status
  chapters
  siteUrl
  startDate { year }
`;

const LIST_QUERY = `
query ($page: Int, $perPage: Int, $sort: [MediaSort], $search: String, $genre: String) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    media(type: MANGA, countryOfOrigin: "KR", isAdult: false, sort: $sort, search: $search, genre: $genre) { ${FIELDS} }
  }
}`;

const RECS_QUERY = `
query ($id: Int) {
  Media(id: $id) {
    recommendations(perPage: 10, sort: RATING_DESC) {
      nodes { mediaRecommendation { ${FIELDS} countryOfOrigin } }
    }
  }
}`;

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 429) throw new Error('AniList rate limit reached — wait a minute and try again.');
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.errors?.length) throw new Error(`AniList: ${json?.errors?.[0]?.message || res.statusText}`);
  return json.data as T;
}

export async function fetchManhwa(opts: {
  sort: SortKey;
  search?: string;
  genre?: string;
  page?: number;
  perPage?: number;
}): Promise<{ items: Manhwa[]; hasNextPage: boolean }> {
  const search = opts.search?.trim() || null;
  const data = await gql<{ Page: { pageInfo: { hasNextPage: boolean }; media: Manhwa[] } }>(LIST_QUERY, {
    page: opts.page ?? 1,
    perPage: opts.perPage ?? 24,
    sort: search ? ['SEARCH_MATCH', opts.sort] : [opts.sort],
    search,
    genre: opts.genre || null,
  });
  return { items: data.Page.media, hasNextPage: data.Page.pageInfo.hasNextPage };
}

export async function fetchRecommendations(id: number): Promise<Manhwa[]> {
  const data = await gql<{
    Media: { recommendations: { nodes: Array<{ mediaRecommendation: (Manhwa & { countryOfOrigin?: string }) | null }> } };
  }>(RECS_QUERY, { id });
  return data.Media.recommendations.nodes
    .map((n) => n.mediaRecommendation)
    .filter((m): m is Manhwa & { countryOfOrigin?: string } => Boolean(m));
}

export function displayTitle(m: Pick<Manhwa, 'title'>): string {
  return m.title.english || m.title.userPreferred || m.title.romaji || m.title.native || 'Untitled';
}

export function cleanDescription(text?: string): string {
  if (!text) return '';
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
