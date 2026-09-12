/**
 * src/sync.ts — orchestration: NTS "My Tracks" → Spotify Liked Songs.
 *
 * Runs from the local runner (scripts/sync.ts), the Worker cron (wrangler.jsonc) or
 * POST /run on the Worker. All state lives in one blob (a JSON file or a KV key):
 *
 *   pending    tracks fetched from NTS, not yet looked up on Spotify (a queue)
 *   synced     NTS uid → Spotify id (done)
 *   unmatched  not on Spotify — retried quietly after 1, 3, 7 and 30 days, or pinned by hand
 *   newestSeen the savedAt of the newest NTS track ever fetched (incremental walk stops there)
 *   backfill   resume cursor for older history: walk below `before` (down to `until`, or the bottom)
 *
 * Every run is budgeted (Cloudflare caps subrequests per invocation): `maxPages` NTS
 * pages and `maxLookups` Spotify look-ups. The NTS walk goes newest → newestSeen
 * (cheap: normally one page); if a walk can't reach known ground within the page budget
 * (the first run over a long history) it leaves a backfill cursor and continues from
 * there on the next tick. Look-ups take the newest saves first — a track you heart now
 * lands on Spotify next tick even while an old backlog is still draining — then retries.
 *
 * Every uid moves pending → synced | unmatched in the same step its outcome is known,
 * so a failed Spotify call leaves it queued rather than lost.
 *
 * Host-agnostic: the same module drives scripts/sync.ts locally with a
 * JSON-file store instead of KV.
 */

import { buildQueries, parseSpotifyTrackId, pickBest, type NtsTrack } from './match'
import { ntsIdToken, walkMyTracks } from './nts'
import { alreadySaved, saveTracks, searchTracks, spotifyAccessToken } from './spotify'

export interface SyncEnv {
  NTS_REFRESH_TOKEN?: string
  NTS_FIREBASE_API_KEY?: string
  SPOTIFY_CLIENT_ID?: string
  SPOTIFY_CLIENT_SECRET?: string
  SPOTIFY_REFRESH_TOKEN?: string
  /** Optional: an ntfy.sh topic URL (or any webhook taking a POSTed text body) that gets a
   *  push the first time a saved track can't be found on Spotify, and once per new failure. */
  NTS_NOTIFY_URL?: string
}

/** ntfy-style push (Title header + text body). Header values must be Latin-1 — keep titles ASCII. */
export async function notify(env: SyncEnv, title: string, body: string): Promise<void> {
  if (!env.NTS_NOTIFY_URL) return
  try {
    await fetch(env.NTS_NOTIFY_URL, { method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8', title, tags: 'musical_note', priority: '3' }, body })
  } catch { /* notification is a nicety */ }
}

export interface PendingEntry { title: string; artists: string[]; savedAt: string }
export interface SyncedEntry { spotifyId: string; at: string; title: string; artists: string[]; matched: string; score: number; savedAt: string }
export interface UnmatchedEntry { title: string; artists: string[]; savedAt: string; tries: number; lastTried: string; lastError?: string }
export interface LastRun { at: string; ms: number; scanned: number; added: number; alreadyLiked: number; unmatched: number; pending: number; error?: string }

export interface SyncState {
  version: 1
  pending: Record<string, PendingEntry>
  synced: Record<string, SyncedEntry>
  unmatched: Record<string, UnmatchedEntry>
  newestSeen?: string
  backfill?: { before: string; until?: string } | null
  /** Set while a run is in flight so an overlapping cron/manual run skips instead of racing. */
  lockedUntil?: string
  lastRun?: LastRun
}

export interface SyncStore {
  /** Must THROW on a read failure — a null here means "no state yet" and gets overwritten. */
  get(): Promise<SyncState | null>
  put(s: SyncState): Promise<void>
}

export interface SyncOptions {
  /** Forget the cursors: re-walk every NTS page (over successive runs) and retry every unmatched track. */
  full?: boolean
  log?: (line: string) => void
  now?: () => number
  /** Test seam for pushes. */
  notify?: (title: string, body: string) => Promise<void>
  /** Spotify look-ups per run (each ≤3 searches). Omit for no cap (local runner). */
  maxLookups?: number
  /** NTS pages per run. Omit for no cap (local runner). */
  maxPages?: number
  /** NTS page size (test seam). */
  pageSize?: number
}

export interface SyncReport extends LastRun {
  addedTracks: { title: string; artists: string; matched: string }[]
  unmatchedTracks: UnmatchedView[]
  skipped?: string
}
export interface UnmatchedView { uid: string; title: string; artists: string; tries: number; lastError?: string }

export const STATE_KEY = 'nts-spotify:state'
const RETRY_AFTER_MS = [1, 3, 7, 30].map((d) => d * 86_400_000) // wait before try 2, 3, 4, 5; then only on `full`
const LOCK_MS = 3 * 60_000
const bySavedAtDesc = <T extends { savedAt: string }>(a: [string, T], b: [string, T]) => b[1].savedAt.localeCompare(a[1].savedAt)
const joinArtists = (a: string[]) => a.join(', ')

export const emptyState = (): SyncState => ({ version: 1, pending: {}, synced: {}, unmatched: {} })
const loadState = async (store: SyncStore): Promise<SyncState> => ({ ...emptyState(), ...((await store.get()) ?? {}) })

export function missingConfig(env: SyncEnv): string[] {
  return (['NTS_REFRESH_TOKEN', 'SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_REFRESH_TOKEN'] as const).filter((k) => !env[k])
}

/** Clamp a user-supplied cap (query string) to a sane positive integer. */
export const clampCap = (raw: unknown, fallback: number, ceiling: number): number => {
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) && n >= 1 ? Math.min(n, ceiling) : fallback
}

/** KV-backed store for the Worker. Read failures propagate (the run aborts without writing). */
export function kvStore(env: { KV?: { get: (k: string, t?: string) => Promise<any>; put: (k: string, v: string) => Promise<void> } }): SyncStore {
  return {
    async get() {
      if (!env.KV) throw new Error('no KV namespace bound — the sync needs somewhere to keep its state')
      return (await env.KV.get(STATE_KEY, 'json')) as SyncState | null
    },
    async put(s) {
      await env.KV!.put(STATE_KEY, JSON.stringify(s))
    },
  }
}

/** Retry ladder: try 1 now; then after 1, 3, 7, 30 days; then only on `full`. */
export const isDue = (u: UnmatchedEntry, now: number): boolean => {
  if (u.tries < 1) return true
  if (u.tries > RETRY_AFTER_MS.length) return false
  return now - Date.parse(u.lastTried) >= RETRY_AFTER_MS[u.tries - 1]
}

/** Try each query in turn; first hit that clears every gate wins. */
async function findOnSpotify(token: string, t: NtsTrack) {
  for (const q of buildQueries(t)) {
    const hits = await searchTracks(token, q)
    const best = pickBest(t, hits)
    if (best) return best
  }
  return null
}

const unmatchedList = (s: SyncState): UnmatchedView[] =>
  Object.entries(s.unmatched).sort(bySavedAtDesc).map(([uid, u]) => ({ uid, title: u.title, artists: joinArtists(u.artists), tries: u.tries, lastError: u.lastError }))

export async function runSync(env: SyncEnv, store: SyncStore, opts: SyncOptions = {}): Promise<SyncReport> {
  const now = opts.now ?? Date.now
  const log = opts.log ?? (() => {})
  const push = opts.notify ?? ((t: string, b: string) => notify(env, t, b))
  const started = now()
  const state = await loadState(store) // throws on a read failure → nothing is written
  const report: SyncReport = { at: new Date(started).toISOString(), ms: 0, scanned: 0, added: 0, alreadyLiked: 0, unmatched: 0, pending: 0, addedTracks: [], unmatchedTracks: [] }
  if (state.lockedUntil && Date.parse(state.lockedUntil) > started) {
    report.skipped = `another run started at ${state.lastRun?.at ?? '?'} is still in flight`
    log(report.skipped)
    return { ...report, unmatched: Object.keys(state.unmatched).length, pending: Object.keys(state.pending).length, unmatchedTracks: unmatchedList(state) }
  }
  const prevError = state.lastRun?.error
  state.lockedUntil = new Date(started + LOCK_MS).toISOString()
  await store.put(state)

  try {
    const missing = missingConfig(env)
    if (missing.length) throw new Error(`not configured — missing ${missing.join(', ')}`)
    const prevNewest = state.newestSeen
    if (opts.full) {
      state.newestSeen = undefined
      state.backfill = undefined
      for (const u of Object.values(state.unmatched)) u.tries = 0
    }

    // 1. NTS → pending. Incremental walk from the top down to the newest timestamp we've
    //    already fetched (dedupe by uid on the way); then, with any page budget left, continue
    //    the backfill of older history.
    const idToken = await ntsIdToken(env.NTS_REFRESH_TOKEN!, env.NTS_FIREBASE_API_KEY || undefined)
    const enqueue = (tracks: NtsTrack[]) => {
      for (const t of tracks) {
        if (t.uid in state.synced || t.uid in state.unmatched || t.uid in state.pending) continue
        if (!t.title) {
          // Nothing to search for — never queued, retried only by hand (pin it).
          state.unmatched[t.uid] = { title: '', artists: t.artists, savedAt: t.savedAt, tries: RETRY_AFTER_MS.length + 1, lastTried: new Date(now()).toISOString(), lastError: 'NTS entry has no title' }
          continue
        }
        state.pending[t.uid] = { title: t.title, artists: t.artists, savedAt: t.savedAt }
        report.scanned++
      }
    }
    const maxPages = opts.maxPages ?? Infinity
    const seenBefore = state.newestSeen
    const inc = await walkMyTracks(idToken, { stop: seenBefore ? (t) => t.savedAt <= seenBefore : undefined, maxPages, pageSize: opts.pageSize })
    enqueue(inc.tracks)
    if (inc.tracks[0] && (!state.newestSeen || inc.tracks[0].savedAt > state.newestSeen)) state.newestSeen = inc.tracks[0].savedAt
    if (!inc.complete && inc.oldest) {
      // Budget ran out mid-walk. Resume below here next time, down to where we'd already
      // been (or to the bottom on a first run). An already-active deeper backfill is
      // folded in: walking to its `until` covers both gaps.
      state.backfill = { before: inc.oldest, until: state.backfill?.until ?? (opts.full ? undefined : prevNewest) }
    }
    const pagesLeft = maxPages - inc.pages
    if (state.backfill && pagesLeft > 0) {
      const { before, until } = state.backfill
      const bf = await walkMyTracks(idToken, { before, stop: until ? (t) => t.savedAt <= until : undefined, maxPages: pagesLeft, pageSize: opts.pageSize })
      enqueue(bf.tracks)
      state.backfill = bf.complete || !bf.oldest ? null : { before: bf.oldest, until }
    }
    log(`NTS: ${report.scanned} new saved track(s) (${inc.pages} page${inc.pages === 1 ? '' : 's'}${state.backfill ? ', backfill continues next run' : ''})`)

    // 2. This run's look-ups: newest saves first, then retries that are due.
    const queue: NtsTrack[] = Object.entries(state.pending).sort(bySavedAtDesc).map(([uid, e]) => ({ uid, ...e }))
    for (const [uid, u] of Object.entries(state.unmatched)) if (u.title && isDue(u, now())) queue.push({ uid, title: u.title, artists: u.artists, savedAt: u.savedAt })
    const batch = queue.slice(0, opts.maxLookups ?? Infinity)
    if (queue.length > batch.length) log(`${queue.length - batch.length} look-up(s) deferred to the next run`)
    if (!batch.length) return report

    // 3. Spotify: match, then like. A uid leaves `pending` only when its outcome is recorded.
    const token = await spotifyAccessToken({ clientId: env.SPOTIFY_CLIENT_ID!, clientSecret: env.SPOTIFY_CLIENT_SECRET!, refreshToken: env.SPOTIFY_REFRESH_TOKEN! })
    const matched: { t: NtsTrack; id: string; name: string; score: number }[] = []
    let outcomes = 0
    for (const t of batch) {
      const prev = state.unmatched[t.uid]
      const stamp = new Date(now()).toISOString()
      const miss = (tries: number, lastError?: string) => {
        state.unmatched[t.uid] = { title: t.title, artists: t.artists, savedAt: t.savedAt, tries, lastTried: stamp, lastError }
        delete state.pending[t.uid]
      }
      try {
        const best = await findOnSpotify(token, t)
        outcomes++
        if (best) {
          const name = `${joinArtists(best.pick.artists)} – ${best.pick.name}`
          matched.push({ t, id: best.pick.id, name, score: best.score })
          log(`  ✓ ${joinArtists(t.artists)} – ${t.title}  →  ${name} (${best.score.toFixed(2)})`)
        } else {
          miss((prev?.tries ?? 0) + 1)
          log(`  ✗ ${joinArtists(t.artists)} – ${t.title}  (not found on Spotify — no fallback)`)
          if (!prev) await push('Not on Spotify', `${joinArtists(t.artists)} – ${t.title}\nSaved on NTS but no exact match on Spotify.`)
        }
      } catch (e: any) {
        // Rate-limited, or the very first look-up failed (auth/permission — systemic): abort the
        // run so it is reported once, leaving everything queued. Otherwise record and move on.
        if (e?.status === 429 || outcomes === 0) throw e
        miss((prev?.tries ?? 0) + 1, String(e?.message ?? e))
        log(`  ! ${joinArtists(t.artists)} – ${t.title}  (${e?.message ?? e})`)
      }
    }

    if (matched.length) {
      const ids = matched.map((m) => m.id)
      const had = await alreadySaved(token, ids)
      const toSave = ids.filter((_, i) => !had[i])
      if (toSave.length) await saveTracks(token, toSave)
      const at = new Date(now()).toISOString()
      matched.forEach((m, i) => {
        state.synced[m.t.uid] = { spotifyId: m.id, at, title: m.t.title, artists: m.t.artists, matched: m.name, score: Math.round(m.score * 100) / 100, savedAt: m.t.savedAt }
        delete state.unmatched[m.t.uid]
        delete state.pending[m.t.uid]
        if (had[i]) report.alreadyLiked++
        else { report.added++; report.addedTracks.push({ title: m.t.title, artists: joinArtists(m.t.artists), matched: m.name }) }
      })
    }
  } catch (e: any) {
    report.error = String(e?.message ?? e)
    log(`error: ${report.error}`)
  } finally {
    report.unmatched = Object.keys(state.unmatched).length
    report.pending = Object.keys(state.pending).length
    report.unmatchedTracks = unmatchedList(state)
    report.ms = now() - started
    const { addedTracks: _a, unmatchedTracks: _u, skipped: _s, ...lastRun } = report
    // One push per *new* failure (e.g. the NTS password changed) — not one per tick.
    state.lastRun = lastRun
    state.lockedUntil = undefined
    await store.put(state)
    if (report.error && report.error !== prevError) await push('NTS to Spotify sync failed', report.error)
  }
  return report
}

/** Manually resolve unmatched/pending tracks: { ntsUid: spotify id | URI | URL }. Likes them too. */
export async function pinMatches(env: SyncEnv, store: SyncStore, pins: Record<string, string>): Promise<{ pinned: string[]; rejected: string[] }> {
  const state = await loadState(store)
  const pinned: string[] = []
  const rejected: string[] = []
  const ids: { uid: string; id: string }[] = []
  for (const [uid, ref] of Object.entries(pins)) {
    const id = parseSpotifyTrackId(String(ref))
    if (!id || !(uid in state.unmatched || uid in state.pending)) { rejected.push(uid); continue }
    ids.push({ uid, id })
  }
  if (ids.length) {
    const token = await spotifyAccessToken({ clientId: env.SPOTIFY_CLIENT_ID!, clientSecret: env.SPOTIFY_CLIENT_SECRET!, refreshToken: env.SPOTIFY_REFRESH_TOKEN! })
    await saveTracks(token, ids.map((x) => x.id))
    const at = new Date().toISOString()
    for (const { uid, id } of ids) {
      const u = (state.unmatched[uid] ?? state.pending[uid])!
      state.synced[uid] = { spotifyId: id, at, title: u.title, artists: u.artists, matched: 'pinned', score: 1, savedAt: u.savedAt }
      delete state.unmatched[uid]
      delete state.pending[uid]
      pinned.push(uid)
    }
    await store.put(state)
  }
  return { pinned, rejected }
}

/** Read-only view for GET /status (Worker) and the local runner. */
export async function syncStatus(env: SyncEnv, store: SyncStore) {
  const s = await loadState(store)
  const missing = missingConfig(env)
  const recent = Object.values(s.synced).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20)
  return {
    configured: missing.length === 0,
    missing,
    lastRun: s.lastRun ?? null,
    syncedCount: Object.keys(s.synced).length,
    pendingCount: Object.keys(s.pending).length,
    backfillInProgress: !!s.backfill,
    recent: recent.map((e) => ({ title: e.title, artists: joinArtists(e.artists), matched: e.matched, at: e.at })),
    unmatched: unmatchedList(s),
  }
}
