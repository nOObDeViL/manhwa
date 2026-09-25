'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ExternalLink, FolderPlus, Search, Star } from 'lucide-react';
import { GENRES, Manhwa, SORTS, SortKey, cleanDescription, displayTitle, fetchManhwa, fetchRecommendations } from '@/lib/anilist';
import { signIn } from '@/lib/auth';
import { createProject } from '@/lib/projects';
import { useSession } from '@/lib/store';
import { cn, errorMessage } from '@/lib/utils';
import { Badge, Button, Input, Modal, Notice, PageHeader, Select, Spinner } from '@/components/ui';
import { selectProject } from '@/components/ProjectPicker';

export default function DiscoverPage() {
  const [sort, setSort] = useState<SortKey>('TRENDING_DESC');
  const [genre, setGenre] = useState('');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<Manhwa[]>([]);
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Manhwa | null>(null);
  const reqId = useRef(0);

  // Debounce the search box.
  useEffect(() => {
    const t = setTimeout(() => setSearch(query), 450);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    fetchManhwa({ sort, genre, search, page })
      .then((res) => {
        if (id !== reqId.current) return;
        setItems((prev) => (page === 1 ? res.items : [...prev, ...res.items.filter((m) => !prev.some((p) => p.id === m.id))]));
        setHasNext(res.hasNextPage);
      })
      .catch((err) => id === reqId.current && setError(errorMessage(err)))
      .finally(() => id === reqId.current && setLoading(false));
  }, [sort, genre, search, page]);

  // Reset to page 1 when filters change.
  useEffect(() => setPage(1), [sort, genre, search]);

  return (
    <div>
      <PageHeader title="Discover manhwa" description="Trending and popular Korean webtoons from AniList. Pick one to create its project folder in Drive." />

      <div className="mb-5 flex flex-wrap gap-2">
        <div className="flex rounded-xl border border-zinc-800 bg-zinc-900/60 p-1">
          {SORTS.map((s) => (
            <button
              key={s.value}
              onClick={() => setSort(s.value)}
              className={cn('rounded-lg px-3 py-1.5 text-sm', sort === s.value ? 'bg-violet-600 text-white' : 'text-zinc-400 hover:text-white')}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-500" />
          <Input className="pl-9" placeholder="Search titles…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Select className="w-44" value={genre} onChange={(e) => setGenre(e.target.value)}>
          <option value="">All genres</option>
          {GENRES.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </Select>
      </div>

      {error && <Notice kind="error" className="mb-4">{error}</Notice>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
        {items.map((m) => (
          <button key={m.id} onClick={() => setSelected(m)} className="group text-left">
            <div className="relative aspect-[2/3] overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900" style={{ backgroundColor: m.coverImage.color }}>
              {m.coverImage.large && (
                <img src={m.coverImage.large} alt="" loading="lazy" className="size-full object-cover transition duration-300 group-hover:scale-105" />
              )}
              {m.averageScore ? (
                <span className="absolute top-2 right-2 flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] text-amber-300">
                  <Star className="size-3 fill-current" /> {m.averageScore}
                </span>
              ) : null}
            </div>
            <div className="mt-2 line-clamp-2 text-sm font-medium text-zinc-100">{displayTitle(m)}</div>
            <div className="mt-0.5 truncate text-[11px] text-zinc-500">{m.genres.slice(0, 3).join(' · ')}</div>
          </button>
        ))}
      </div>

      <div className="mt-6 flex justify-center">
        {loading ? <Spinner /> : hasNext && <Button onClick={() => setPage((p) => p + 1)}>Load more</Button>}
      </div>

      <DetailModal manhwa={selected} onClose={() => setSelected(null)} onSelect={setSelected} />
    </div>
  );
}

function DetailModal({ manhwa, onClose, onSelect }: { manhwa: Manhwa | null; onClose: () => void; onSelect: (m: Manhwa) => void }) {
  const token = useSession((s) => s.token);
  const projectsId = useSession((s) => s.projectsId);
  const toast = useSession((s) => s.toast);
  const [recs, setRecs] = useState<Manhwa[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  useEffect(() => {
    setRecs(null);
    setCreated(null);
    if (!manhwa) return;
    let alive = true;
    fetchRecommendations(manhwa.id)
      .then((r) => alive && setRecs(r))
      .catch(() => alive && setRecs([]));
    return () => {
      alive = false;
    };
  }, [manhwa]);

  if (!manhwa) return null;
  const title = displayTitle(manhwa);
  const synopsis = cleanDescription(manhwa.description);

  const create = async () => {
    setBusy(true);
    try {
      if (!token) await signIn();
      // Wait for the shell to finish preparing the Drive folder after a fresh sign-in.
      let pid = useSession.getState().projectsId;
      for (let i = 0; i < 50 && !pid; i++) {
        await new Promise((r) => setTimeout(r, 200));
        pid = useSession.getState().projectsId;
      }
      if (!pid) throw new Error('Drive is not ready yet — try again in a moment.');
      const project = await createProject(pid, {
        title,
        anilistId: manhwa.id,
        coverImage: manhwa.coverImage.extraLarge || manhwa.coverImage.large,
        bannerImage: manhwa.bannerImage,
        synopsis,
        genres: manhwa.genres,
        siteUrl: manhwa.siteUrl,
      });
      await selectProject(project.id);
      setCreated(project.name);
      toast(`Project folder “${project.name}” created in Drive.`, 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={title} wide>
      <div className="relative -m-4 mb-4 h-32 overflow-hidden sm:h-44" style={{ backgroundColor: manhwa.coverImage.color || '#18181b' }}>
        {manhwa.bannerImage && <img src={manhwa.bannerImage} alt="" className="size-full object-cover opacity-70" />}
        <div className="absolute inset-0 bg-gradient-to-t from-zinc-900 to-transparent" />
      </div>
      <div className="flex flex-col gap-5 sm:flex-row">
        <img src={manhwa.coverImage.extraLarge || manhwa.coverImage.large} alt="" className="-mt-20 w-32 shrink-0 self-start rounded-xl border border-zinc-700 shadow-2xl sm:w-40" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap gap-1.5">
            {manhwa.genres.map((g) => (
              <Badge key={g}>{g}</Badge>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
            {manhwa.averageScore ? <span>Score {manhwa.averageScore}%</span> : null}
            {manhwa.status && <span>{manhwa.status.replace(/_/g, ' ').toLowerCase()}</span>}
            {manhwa.chapters ? <span>{manhwa.chapters} chapters</span> : null}
            {manhwa.startDate?.year ? <span>since {manhwa.startDate.year}</span> : null}
            {manhwa.title.native && <span>{manhwa.title.native}</span>}
          </div>
          <p className="mt-3 max-h-56 overflow-y-auto whitespace-pre-line text-sm leading-relaxed text-zinc-300">{synopsis || 'No synopsis available.'}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" loading={busy} onClick={create} icon={<FolderPlus className="size-4" />}>
              Create Project folder in Drive
            </Button>
            {manhwa.siteUrl && (
              <a href={manhwa.siteUrl} target="_blank" rel="noreferrer">
                <Button icon={<ExternalLink className="size-4" />}>AniList</Button>
              </a>
            )}
          </div>
          {created && (
            <Notice kind="success" className="mt-3">
              “{created}” is now your active project. Next:{' '}
              <Link href="/slicer" className="underline">
                slice panels
              </Link>{' '}
              or{' '}
              <Link href="/script" className="underline">
                write the script
              </Link>
              .
            </Notice>
          )}
          {!projectsId && token && <p className="mt-2 text-xs text-zinc-500">Preparing your Drive folder…</p>}
        </div>
      </div>

      <h3 className="mt-6 mb-3 text-sm font-semibold text-zinc-200">If you like this, recap these next</h3>
      {recs === null ? (
        <Spinner />
      ) : recs.length === 0 ? (
        <p className="text-sm text-zinc-500">No recommendations yet.</p>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {recs.map((r) => (
            <button key={r.id} onClick={() => onSelect(r)} className="w-24 shrink-0 text-left">
              <img src={r.coverImage.large} alt="" className="aspect-[2/3] w-full rounded-lg object-cover" loading="lazy" />
              <div className="mt-1 line-clamp-2 text-[11px] text-zinc-300">{displayTitle(r)}</div>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
