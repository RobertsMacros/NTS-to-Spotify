/**
 * NTS → Spotify sync — matcher gates + orchestration (src/).
 *
 * The user's rule: it must be THAT version — a remix/edit/dub/live take is a different
 * track — and if nothing clears the bar we say "not found" rather than settling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildQueries, normalise, parseSpotifyTrackId, pickBest, scoreCandidate, splitArtists, stripFeat, versionTags, type NtsTrack, type SpotifyCandidate } from '../src/match'
import { clampCap, emptyState, isDue, pinMatches, runSync, type SyncState, type SyncStore } from '../src/sync'

const nts = (title: string, artists: string[], uid = 't1'): NtsTrack => ({ uid, title, artists, savedAt: '2026-09-01T00:00:00.000Z' })
const sp = (id: string, name: string, artists: string[]): SpotifyCandidate => ({ id, name, artists })

describe('normalisation', () => {
  it('strips diacritics, punctuation and unifies feat/&', () => {
    expect(normalise('Björk — Jóga (feat. X)')).toBe('bjork joga feat x')
    expect(normalise('Simon & Garfunkel')).toBe('simon and garfunkel')
    expect(normalise("Don't Stop Ft. Me")).toBe('dont stop feat me')
  })
  it('stripFeat removes guest clauses but keeps version qualifiers', () => {
    expect(stripFeat('Song (feat. Guest)')).toBe('Song')
    expect(stripFeat('Song feat. Guest')).toBe('Song')
    expect(stripFeat('Song (with Guest)')).toBe('Song')
    expect(stripFeat('Song (Dub Mix)')).toBe('Song (Dub Mix)')
  })
  it('splits joint artist credits', () => {
    expect(splitArtists(['Four Tet & Burial', 'Thom Yorke x Fred again..'])).toEqual(['Four Tet', 'Burial', 'Thom Yorke', 'Fred again..'])
  })
})

describe('versionTags — what counts as a different version', () => {
  it('ignores Original Mix / remaster / year but keeps remix, dub, edit, live', () => {
    expect([...versionTags('Song (Original Mix)')]).toEqual([])
    expect([...versionTags('Song - 2011 Remaster')]).toEqual([])
    expect([...versionTags('Song')]).toEqual([])
    expect([...versionTags('Song (Four Tet Remix)')].sort()).toEqual(['four', 'remix', 'tet'])
    expect([...versionTags('Song (Dub)')]).toEqual(['dub'])
    expect([...versionTags('Song (Dub Mix)')]).toEqual(['dub']) // "mix" itself is neutral
    expect([...versionTags('Song - Extended Mix')]).toEqual(['extended'])
    expect([...versionTags('Song - Live at Glastonbury')].sort()).toEqual(['at', 'glastonbury', 'live'])
    expect([...versionTags('Song Remix')]).toEqual(['remix'])
  })
})

describe('pickBest — same version only, else null', () => {
  it('accepts the exact track with cosmetic differences', () => {
    const t = nts('Jóga', ['Björk'])
    const r = pickBest(t, [sp('a', 'Joga', ['Björk'])])
    expect(r?.pick.id).toBe('a')
  })
  it('accepts "Original Mix" / remaster as the same recording', () => {
    expect(pickBest(nts('Xtal', ['Aphex Twin']), [sp('a', 'Xtal - 2019 Remaster', ['Aphex Twin'])])?.pick.id).toBe('a')
    expect(pickBest(nts('Xtal', ['Aphex Twin']), [sp('a', 'Xtal (Original Mix)', ['Aphex Twin'])])?.pick.id).toBe('a')
  })
  it('rejects a remix / dub / edit / live take when NTS saved the original', () => {
    const t = nts('Archangel', ['Burial'])
    expect(pickBest(t, [sp('r', 'Archangel (Four Tet Remix)', ['Burial', 'Four Tet'])])).toBeNull()
    expect(pickBest(t, [sp('d', 'Archangel (Dub)', ['Burial'])])).toBeNull()
    expect(pickBest(t, [sp('e', 'Archangel - Radio Edit', ['Burial'])])).toBeNull()
    expect(pickBest(t, [sp('l', 'Archangel (Live)', ['Burial'])])).toBeNull()
  })
  it('rejects the original when NTS saved the remix, and picks the right remix', () => {
    const t = nts('Archangel (Four Tet Remix)', ['Burial'])
    const r = pickBest(t, [sp('o', 'Archangel', ['Burial']), sp('x', 'Archangel (Boards of Canada Remix)', ['Burial']), sp('r', 'Archangel (Four Tet Remix)', ['Burial', 'Four Tet'])])
    expect(r?.pick.id).toBe('r')
  })
  it('rejects a cover (right title, wrong artist)', () => {
    expect(pickBest(nts('Hallelujah', ['Leonard Cohen']), [sp('c', 'Hallelujah', ['Jeff Buckley'])])).toBeNull()
  })
  it('rejects a merely similar title', () => {
    expect(pickBest(nts('Blue Monday', ['New Order']), [sp('x', 'Blue Monday 88', ['New Order'])])).toBeNull()
    expect(pickBest(nts('Teardrop', ['Massive Attack']), [sp('x', 'Teardrops', ['Massive Attack'])])?.pick.id).toBeUndefined()
  })
  it('tolerates the guest moving between title and artist list', () => {
    const t = nts('Where Are Ü Now', ['Jack Ü', 'Justin Bieber'])
    expect(pickBest(t, [sp('a', 'Where Are Ü Now (with Justin Bieber)', ['Jack Ü', 'Skrillex', 'Diplo'])])?.pick.id).toBe('a') // "(with …)" is a guest credit, not a version
    const u = nts('Song', ['Artist', 'Guest'])
    expect(pickBest(u, [sp('b', 'Song (feat. Guest)', ['Artist', 'Guest'])])?.pick.id).toBe('b')
  })
  it('scores are explicable', () => {
    const s = scoreCandidate(nts('Archangel', ['Burial']), sp('r', 'Archangel (Four Tet Remix)', ['Burial']))
    expect(s.sameVersion).toBe(false)
    expect(s.score).toBe(0)
  })
})

describe('queries + ids', () => {
  it('fielded query first, then free text, no quotes leaking, no bare-title fallback', () => {
    const q = buildQueries(nts('Song "Two" (feat. G)', ['A & B']))
    expect(q[0]).toBe('track:"Song Two" artist:"A"')
    expect(q[1]).toBe('Song Two A')
    expect(q).toHaveLength(3)
    expect(q).not.toContain('Song Two')
  })
  it('parses Spotify ids from URL / URI / bare id', () => {
    expect(parseSpotifyTrackId('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc')).toBe('4uLU6hMCjMI75M1A2tKUQC')
    expect(parseSpotifyTrackId('https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC')).toBe('4uLU6hMCjMI75M1A2tKUQC')
    expect(parseSpotifyTrackId('spotify:track:4uLU6hMCjMI75M1A2tKUQC')).toBe('4uLU6hMCjMI75M1A2tKUQC')
    expect(parseSpotifyTrackId('4uLU6hMCjMI75M1A2tKUQC')).toBe('4uLU6hMCjMI75M1A2tKUQC')
    expect(parseSpotifyTrackId('nonsense')).toBeNull()
    expect(parseSpotifyTrackId('https://open.spotify.com/album/4uLU6hMCjMI75M1A2tKUQC')).toBeNull() // not a track
    expect(parseSpotifyTrackId('spotify:artist:4uLU6hMCjMI75M1A2tKUQC')).toBeNull()
  })
  it('clamps a user-supplied cap', () => {
    expect(clampCap('-5', 10, 300)).toBe(10)
    expect(clampCap('0', 10, 300)).toBe(10)
    expect(clampCap('abc', 10, 300)).toBe(10)
    expect(clampCap('1e9', 10, 300)).toBe(300)
    expect(clampCap('2.7', 10, 300)).toBe(2)
  })
})

// ---------- orchestration with a fake NTS + Spotify ----------

const memStore = (init: SyncState | null = null): SyncStore & { state: SyncState | null } => {
  const s = { state: init, async get() { return s.state }, async put(x: SyncState) { s.state = JSON.parse(JSON.stringify(x)) } }
  return s
}
const env = { NTS_REFRESH_TOKEN: 'n', SPOTIFY_CLIENT_ID: 'i', SPOTIFY_CLIENT_SECRET: 's', SPOTIFY_REFRESH_TOKEN: 'r' }

type Fake = { ntsTracks: any[]; catalogue: SpotifyCandidate[]; liked: Set<string>; calls: string[] }
function fakeFetch(f: Fake) {
  return vi.fn(async (input: any, init: any = {}) => {
    const url = String(input)
    f.calls.push(url.split('?')[0])
    const ok = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url.includes('securetoken')) return ok({ id_token: 'nts-id' })
    if (url.includes('getMyTracksEurope')) {
      const { createdBefore, limit = 50 } = JSON.parse(init.body).data
      const sorted = [...f.ntsTracks].sort((a, b) => b.created_at.localeCompare(a.created_at)).filter((t) => !createdBefore || t.created_at < createdBefore)
      const page = sorted.slice(0, limit)
      return ok({ result: { results: page, metadata: { resultset: { is_final_page: sorted.length <= limit } } } })
    }
    if (url.includes('accounts.spotify.com')) return ok({ access_token: 'sp' })
    if (url.includes('/v1/search')) {
      const q = new URL(url).searchParams.get('q')!.toLowerCase().replace(/track:|artist:|"/g, '')
      const words = q.split(/\s+/).filter(Boolean)
      const items = f.catalogue.filter((c) => words.some((w) => `${c.name} ${c.artists.join(' ')}`.toLowerCase().includes(w)))
      return ok({ tracks: { items: items.map((c) => ({ id: c.id, name: c.name, artists: c.artists.map((name) => ({ name })) })) } })
    }
    if (url.includes('/v1/me/tracks/contains')) return ok(new URL(url).searchParams.get('ids')!.split(',').map((id) => f.liked.has(id)))
    if (url.includes('/v1/me/tracks') && init.method === 'PUT') { for (const id of JSON.parse(init.body).ids) f.liked.add(id); return new Response(null, { status: 200 }) }
    if (url.includes('ntfy')) return new Response('ok')
    throw new Error(`unexpected fetch ${url}`)
  })
}

describe('runSync', () => {
  let fake: Fake
  beforeEach(() => {
    fake = {
      ntsTracks: [
        { track_uid: 'u1', song_title: 'Archangel', artist_names: ['Burial'], created_at: '2026-09-01T10:00:00Z' },
        { track_uid: 'u2', song_title: 'Unreleased Dubplate', artist_names: ['Nobody'], created_at: '2026-09-01T11:00:00Z' },
        { track_uid: 'u3', song_title: 'Xtal', artist_names: ['Aphex Twin'], created_at: '2026-09-01T12:00:00Z' },
      ],
      catalogue: [sp('arch', 'Archangel', ['Burial']), sp('archr', 'Archangel (Four Tet Remix)', ['Burial']), sp('xtal', 'Xtal', ['Aphex Twin'])],
      liked: new Set(['xtal']),
      calls: [],
    }
    vi.stubGlobal('fetch', fakeFetch(fake))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('likes exact matches, reports already-liked, notifies once for not-found (no fallback)', async () => {
    const store = memStore()
    const pushes: string[] = []
    const r = await runSync(env, store, { notify: async (_t, b) => { pushes.push(b) } })
    expect(r.error).toBeUndefined()
    expect(r.scanned).toBe(3)
    expect(r.added).toBe(1) // Archangel — and NOT the remix
    expect(r.alreadyLiked).toBe(1) // Xtal
    expect(r.unmatched).toBe(1)
    expect(fake.liked.has('arch')).toBe(true)
    expect(fake.liked.has('archr')).toBe(false)
    expect(store.state!.synced.u1.spotifyId).toBe('arch')
    expect(store.state!.unmatched.u2.tries).toBe(1)
    expect(pushes).toEqual(['Nobody – Unreleased Dubplate\nSaved on NTS but no exact match on Spotify.'])

    // second run: nothing new, unmatched not due yet → no Spotify traffic, no repeat push
    fake.calls = []
    const r2 = await runSync(env, store, { notify: async (_t, b) => { pushes.push(b) } })
    expect(r2.scanned).toBe(0)
    expect(fake.calls.some((c) => c.includes('spotify'))).toBe(false)
    expect(pushes).toHaveLength(1)
  })

  it('is incremental: a new NTS save is picked up without re-walking old pages', async () => {
    const store = memStore()
    await runSync(env, store, { notify: async () => {} })
    fake.ntsTracks.push({ track_uid: 'u4', song_title: 'Xtal', artist_names: ['Aphex Twin'], created_at: '2026-09-02T00:00:00Z' })
    fake.liked.delete('xtal')
    fake.calls = []
    const r = await runSync(env, store, { notify: async () => {} })
    expect(r.scanned).toBe(1)
    expect(r.added).toBe(1)
    expect(fake.calls.filter((c) => c.includes('getMyTracksEurope'))).toHaveLength(1)
  })

  it('retries a not-found track after the backoff, silently, and resolves it once it appears', async () => {
    const store = memStore()
    const pushes: string[] = []
    const t0 = Date.parse('2026-09-03T00:00:00Z')
    await runSync(env, store, { notify: async (_t, b) => { pushes.push(b) }, now: () => t0 })
    fake.catalogue.push(sp('dub', 'Unreleased Dubplate', ['Nobody']))
    const r1 = await runSync(env, store, { notify: async (_t, b) => { pushes.push(b) }, now: () => t0 + 3_600_000 }) // 1h later: not due
    expect(r1.added).toBe(0)
    const r2 = await runSync(env, store, { notify: async (_t, b) => { pushes.push(b) }, now: () => t0 + 2 * 86_400_000 }) // 2d later: due
    expect(r2.added).toBe(1)
    expect(store.state!.unmatched.u2).toBeUndefined()
    expect(store.state!.synced.u2.spotifyId).toBe('dub')
    expect(pushes).toHaveLength(1)
  })

  it('caps look-ups per run, NEWEST first, and drains the backlog on later runs', async () => {
    const store = memStore()
    const r1 = await runSync(env, store, { notify: async () => {}, maxLookups: 1 })
    expect(r1.scanned).toBe(3)
    expect(r1.pending).toBe(2)
    expect(r1.alreadyLiked).toBe(1) // u3 Xtal — the NEWEST save — goes first
    expect(store.state!.synced.u3).toBeDefined()
    expect(store.state!.synced.u1).toBeUndefined()
    const r2 = await runSync(env, store, { notify: async () => {}, maxLookups: 1 })
    expect(r2.unmatched).toBe(1) // u2
    const r3 = await runSync(env, store, { notify: async () => {}, maxLookups: 1 })
    expect(r3.added).toBe(1) // u1
    expect(r3.pending).toBe(0)
    const r4 = await runSync(env, store, { notify: async () => {}, maxLookups: 1 })
    expect(r4.scanned).toBe(0)
  })

  it('a new save jumps the queue ahead of due retries and an old backlog', async () => {
    const store = memStore()
    const t0 = Date.parse('2026-09-03T00:00:00Z')
    await runSync(env, store, { notify: async () => {}, now: () => t0 }) // u2 unmatched
    fake.ntsTracks.push({ track_uid: 'u5', song_title: 'Xtal', artist_names: ['Aphex Twin'], created_at: '2026-09-04T00:00:00Z' })
    fake.liked.delete('xtal')
    fake.calls = []
    const r = await runSync(env, store, { notify: async () => {}, now: () => t0 + 2 * 86_400_000, maxLookups: 1 }) // u2 is due, but u5 goes first
    expect(r.added).toBe(1)
    expect(store.state!.synced.u5).toBeDefined()
    expect(store.state!.unmatched.u2.tries).toBe(1)
  })

  it('page budget: a long history is walked over successive runs via the backfill cursor', async () => {
    for (let i = 0; i < 9; i++) fake.ntsTracks.push({ track_uid: `x${i}`, song_title: 'Xtal', artist_names: ['Aphex Twin'], created_at: `2026-08-0${i + 1}T00:00:00Z` })
    const store = memStore()
    const o = { notify: async () => {}, pageSize: 4, maxPages: 1, maxLookups: 100 }
    const r1 = await runSync(env, store, o)
    expect(r1.scanned).toBe(4)
    expect(store.state!.backfill).toEqual({ before: '2026-08-09T00:00:00.000Z' })
    expect(store.state!.newestSeen).toBe('2026-09-01T12:00:00.000Z')
    const r2 = await runSync(env, store, o) // incremental page (stops at once: top is known) — no budget left for backfill
    expect(r2.scanned).toBe(0)
    const r3 = await runSync(env, store, { ...o, maxPages: 2 }) // 1 incremental + 1 backfill page
    expect(r3.scanned).toBe(4)
    const r4 = await runSync(env, store, { ...o, maxPages: 2 })
    expect(r4.scanned).toBe(4)
    expect(store.state!.backfill).toBeNull() // reached the bottom
    const all = Object.keys(store.state!.synced).length + Object.keys(store.state!.unmatched).length
    expect(all).toBe(12)
    // a new save while backfilling still lands next run
    fake.ntsTracks.push({ track_uid: 'n1', song_title: 'Xtal', artist_names: ['Aphex Twin'], created_at: '2026-09-09T00:00:00Z' })
    const r5 = await runSync(env, store, o)
    expect(r5.scanned).toBe(1)
    expect(store.state!.synced.n1).toBeDefined()
  })

  it('pushes once per NEW failure, not every tick', async () => {
    const store = memStore()
    const pushes: string[] = []
    const bad = { ...env, NTS_REFRESH_TOKEN: 'revoked' }
    vi.stubGlobal('fetch', vi.fn(async (input: any) => (String(input).includes('securetoken') ? new Response('{"error":{"message":"TOKEN_EXPIRED"}}', { status: 400 }) : new Response('ok'))))
    const r1 = await runSync(bad, store, { notify: async (t) => { pushes.push(t) } })
    expect(r1.error).toMatch(/TOKEN_EXPIRED/)
    await runSync(bad, store, { notify: async (t) => { pushes.push(t) } })
    expect(pushes).toEqual(['NTS to Spotify sync failed'])
  })

  it('full mode really re-walks NTS (finds a track missing from state) and retries every unmatched track', async () => {
    const store = memStore()
    await runSync(env, store, { notify: async () => {} })
    delete store.state!.synced.u1 // simulate a lost row
    store.state!.unmatched.u2.tries = 9
    fake.catalogue.push(sp('dub', 'Unreleased Dubplate', ['Nobody']))
    const r0 = await runSync(env, store, { notify: async () => {} }) // incremental: sees nothing new
    expect(r0.scanned).toBe(0)
    const r = await runSync(env, store, { notify: async () => {}, full: true })
    expect(r.scanned).toBe(1) // u1 re-found
    expect(r.added).toBe(1) // u2 via retry (u1 is already liked on Spotify → alreadyLiked)
    expect(r.alreadyLiked).toBe(1)
    expect(store.state!.synced.u1).toBeDefined()
    expect(store.state!.synced.u2).toBeDefined()
  })

  it('re-hearting an already-synced track does not hide a newer save beneath it', async () => {
    const store = memStore()
    await runSync(env, store, { notify: async () => {} })
    fake.ntsTracks.push({ track_uid: 'n2', song_title: 'Xtal', artist_names: ['Aphex Twin'], created_at: '2026-09-05T00:00:00Z' })
    const u1 = fake.ntsTracks.find((t) => t.track_uid === 'u1')!
    u1.created_at = '2026-09-06T00:00:00Z' // Archangel re-saved: same uid, now on top
    fake.liked.delete('xtal')
    const r = await runSync(env, store, { notify: async () => {} })
    expect(r.scanned).toBe(1)
    expect(r.added).toBe(1)
    expect(store.state!.synced.n2).toBeDefined()
  })

  it('a failed like leaves matched tracks queued, never lost', async () => {
    const store = memStore()
    const inner = fakeFetch(fake)
    vi.stubGlobal('fetch', vi.fn(async (input: any, init: any) => (String(input).includes('/v1/me/tracks') ? new Response('{"error":{"message":"boom"}}', { status: 503 }) : inner(input, init))))
    const r = await runSync(env, store, { notify: async () => {} })
    expect(r.error).toMatch(/503/)
    expect(Object.keys(store.state!.pending).sort()).toEqual(['u1', 'u3']) // matched but not liked → still pending
    expect(store.state!.unmatched.u2).toBeDefined()
    vi.stubGlobal('fetch', inner)
    const r2 = await runSync(env, store, { notify: async () => {} })
    expect(r2.added + r2.alreadyLiked).toBe(2)
    expect(store.state!.pending).toEqual({})
  })

  it('a systemic Spotify failure aborts the run and is reported once; nothing is marked unmatched', async () => {
    const store = memStore()
    const inner = fakeFetch(fake)
    vi.stubGlobal('fetch', vi.fn(async (input: any, init: any) => (String(input).includes('/v1/search') ? new Response('{"error":{"message":"forbidden"}}', { status: 403 }) : inner(input, init))))
    const pushes: string[] = []
    const r = await runSync(env, store, { notify: async (t) => { pushes.push(t) } })
    expect(r.error).toMatch(/403/)
    expect(Object.keys(store.state!.unmatched)).toEqual([])
    expect(Object.keys(store.state!.pending)).toHaveLength(3)
    await runSync(env, store, { notify: async (t) => { pushes.push(t) } })
    expect(pushes).toEqual(['NTS to Spotify sync failed'])
  })

  it('a state read failure aborts before anything is written', async () => {
    const store = memStore()
    store.get = async () => { throw new Error('KV down') }
    let put = 0
    store.put = async () => { put++ }
    await expect(runSync(env, store, { notify: async () => {} })).rejects.toThrow(/KV down/)
    expect(put).toBe(0)
  })

  it('an overlapping run is skipped while the lock is held', async () => {
    const store = memStore({ ...emptyState(), lockedUntil: new Date(Date.now() + 60_000).toISOString() })
    const r = await runSync(env, store, { notify: async () => {} })
    expect(r.skipped).toMatch(/in flight/)
    expect(fake.calls).toEqual([])
  })

  it('pins only known uids and only track ids', async () => {
    const store = memStore()
    await runSync(env, store, { notify: async () => {} })
    const r = await pinMatches(env, store, { u2: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', ghost: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC', u9: 'https://open.spotify.com/album/4uLU6hMCjMI75M1A2tKUQC' })
    expect(r.pinned).toEqual(['u2'])
    expect(r.rejected.sort()).toEqual(['ghost', 'u9'])
    expect(fake.liked.has('4uLU6hMCjMI75M1A2tKUQC')).toBe(true)
    expect(store.state!.synced.u2.matched).toBe('pinned')
  })

  it('retry ladder: now, then 1 / 3 / 7 / 30 days, then never', () => {
    const base = { title: 't', artists: ['a'], savedAt: '2026-09-01T00:00:00Z', lastTried: '2026-09-01T00:00:00Z' }
    const now = Date.parse('2026-09-01T00:10:00Z')
    const day = 86_400_000
    expect(isDue({ ...base, tries: 0 }, now)).toBe(true)
    expect(isDue({ ...base, tries: 1 }, now)).toBe(false)
    expect(isDue({ ...base, tries: 1 }, now + day)).toBe(true)
    expect(isDue({ ...base, tries: 4 }, now + 29 * day)).toBe(false)
    expect(isDue({ ...base, tries: 4 }, now + 30 * day)).toBe(true)
    expect(isDue({ ...base, tries: 5 }, now + 365 * day)).toBe(false)
  })

  it('records an NTS entry with no title as unmatched (never retried, pin by hand)', async () => {
    fake.ntsTracks.push({ track_uid: 'u9', song_title: '', artist_names: ['Someone'], created_at: '2026-09-05T00:00:00Z' })
    const store = memStore()
    await runSync(env, store, { notify: async () => {} })
    expect(store.state!.unmatched.u9?.lastError).toMatch(/no title/)
    fake.calls = []
    const r = await runSync(env, store, { notify: async () => {} })
    expect(r.scanned).toBe(0)
  })

  it('reports missing configuration instead of throwing', async () => {
    const store = memStore(emptyState())
    const r = await runSync({}, store, {})
    expect(r.error).toMatch(/NTS_REFRESH_TOKEN/)
    expect(store.state!.lastRun?.error).toMatch(/not configured/)
  })
})
