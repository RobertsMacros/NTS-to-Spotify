/**
 * src/nts.ts — read your NTS "My Tracks" (the tracks you save/heart on
 * nts.live or in the NTS app).
 *
 * NTS has no public API for this: the website talks to Firebase (project `nts-ios-app`)
 * and reads saved tracks through the callable Cloud Function `getMyTracksEurope`.
 * We do exactly what the site does — mint a Firebase ID token from a long-lived refresh
 * token, then POST to the function with a Bearer header. The API key below is the
 * PUBLIC web-app key shipped in nts.live's own JS bundle (a Firebase web key is an
 * identifier, not a secret); the only secret is your NTS_REFRESH_TOKEN.
 */

import type { NtsTrack } from './match'

export const NTS_FIREBASE_API_KEY = 'AIzaSyA4Qp5AvHC8Rev72-10-_DY614w_bxUCJU'
const NTS_FUNCTIONS = 'https://europe-west2-nts-ios-app.cloudfunctions.net'
const IDENTITY = 'https://identitytoolkit.googleapis.com/v1/accounts'

async function readJson(r: Response, what: string): Promise<any> {
  const text = await r.text()
  let body: any = null
  try { body = JSON.parse(text) } catch { /* non-JSON error body */ }
  if (!r.ok) {
    const msg = body?.error?.message ?? body?.error ?? text.slice(0, 200)
    throw new Error(`${what}: HTTP ${r.status} ${msg}`)
  }
  return body
}

/** One-off (setup script): email + password → { idToken, refreshToken }. */
export async function ntsSignIn(email: string, password: string, apiKey = NTS_FIREBASE_API_KEY) {
  const r = await fetch(`${IDENTITY}:signInWithPassword?key=${apiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  })
  const j = await readJson(r, 'NTS sign-in')
  return { idToken: j.idToken as string, refreshToken: j.refreshToken as string, email: j.email as string }
}

/** Every run: refresh token → short-lived ID token (Firebase refresh tokens don't expire). */
export async function ntsIdToken(refreshToken: string, apiKey = NTS_FIREBASE_API_KEY): Promise<string> {
  const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${apiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
  })
  const j = await readJson(r, 'NTS token refresh')
  return j.id_token as string
}

/** created_at as ISO. Accepts an ISO/RFC string, epoch ms, or a Firestore-style
 *  { seconds | _seconds } object; anything unparseable falls back to the epoch so the row
 *  is kept (and sorts last) rather than failing the whole run. */
export function isoDate(v: unknown): string {
  const raw = v && typeof v === 'object' ? Number((v as any).seconds ?? (v as any)._seconds) * 1000 : v
  const d = new Date(raw as any)
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString()
}

export interface MyTracksPage { tracks: NtsTrack[]; isLastPage: boolean }

/** One page of My Tracks, newest first. `createdBefore` (ISO) pages backwards in time. */
export async function fetchMyTracksPage(idToken: string, opts: { createdBefore?: string; limit?: number } = {}): Promise<MyTracksPage> {
  const r = await fetch(`${NTS_FUNCTIONS}/getMyTracksEurope`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ data: { createdBefore: opts.createdBefore, limit: opts.limit ?? 50 } }),
  })
  const j = await readJson(r, 'NTS My Tracks')
  if (j?.error) throw new Error(`NTS My Tracks: ${j.error.message ?? JSON.stringify(j.error)}`)
  const results: any[] = j?.result?.results ?? []
  const tracks: NtsTrack[] = results
    .filter((t) => t && t.track_uid)
    .map((t) => ({
      uid: String(t.track_uid),
      title: String(t.song_title ?? '').trim(),
      artists: Array.isArray(t.artist_names) ? t.artist_names.map(String).filter(Boolean) : [],
      savedAt: isoDate(t.created_at),
    }))
  const final = j?.result?.metadata?.resultset?.is_final_page
  return { tracks, isLastPage: typeof final === 'boolean' ? final : tracks.length === 0 }
}

export interface Walk {
  tracks: NtsTrack[]
  /** savedAt of the oldest track fetched — the cursor to continue from next time. */
  oldest?: string
  /** true when the final page or the stop condition was reached; false when maxPages ran out. */
  complete: boolean
  pages: number
}

/**
 * Walk pages newest → oldest, starting below `before` if given, until `stop(track)` says
 * we've reached ground we already know, the final page, or `maxPages` (a request
 * budget — the caller persists `oldest` and resumes on the next run).
 */
export async function walkMyTracks(idToken: string, opts: { before?: string; stop?: (t: NtsTrack) => boolean; maxPages: number; pageSize?: number }): Promise<Walk> {
  const out: NtsTrack[] = []
  const seen = new Set<string>()
  let createdBefore = opts.before
  let pages = 0
  while (pages < opts.maxPages) {
    const { tracks, isLastPage } = await fetchMyTracksPage(idToken, { createdBefore, limit: opts.pageSize })
    pages++
    for (const t of tracks) {
      if (seen.has(t.uid)) continue
      seen.add(t.uid)
      if (opts.stop?.(t)) return { tracks: out, oldest: t.savedAt, complete: true, pages }
      out.push(t)
    }
    if (isLastPage || tracks.length === 0) return { tracks: out, oldest: out[out.length - 1]?.savedAt ?? createdBefore, complete: true, pages }
    const oldest = tracks[tracks.length - 1].savedAt
    if (oldest === createdBefore) throw new Error('NTS My Tracks: paging made no progress (cursor ignored?)') // never spin, never claim completion
    createdBefore = oldest
  }
  return { tracks: out, oldest: createdBefore, complete: false, pages }
}
