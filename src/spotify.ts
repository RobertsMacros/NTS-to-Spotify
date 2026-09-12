/**
 * src/spotify.ts — the four Spotify Web API calls the sync needs.
 *
 * Auth is the Authorization Code flow with a client secret, so the refresh token is
 * stable (PKCE rotates it on every refresh, which is awkward for a Worker secret).
 * Scopes: user-library-read user-library-modify. Get the refresh token once with
 * `npm run setup`.
 */

import type { SpotifyCandidate } from './match'

const ACCOUNTS = 'https://accounts.spotify.com/api/token'
const API = 'https://api.spotify.com/v1'
export const SPOTIFY_SCOPES = 'user-library-read user-library-modify'

export interface SpotifyAuth { clientId: string; clientSecret: string; refreshToken: string }

function basic(id: string, secret: string): string {
  return 'Basic ' + btoa(`${id}:${secret}`)
}

/** Refresh token → short-lived access token. */
export async function spotifyAccessToken(a: SpotifyAuth): Promise<string> {
  const r = await fetch(ACCOUNTS, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic(a.clientId, a.clientSecret) },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: a.refreshToken }).toString(),
  })
  const j: any = await r.json().catch(() => ({}))
  if (!r.ok || !j.access_token) throw new Error(`Spotify token refresh: HTTP ${r.status} ${j.error_description ?? j.error ?? ''}`)
  return j.access_token as string
}

/** One-off (setup script): authorisation code → { refreshToken, accessToken }. */
export async function spotifyExchangeCode(clientId: string, clientSecret: string, code: string, redirectUri: string) {
  const r = await fetch(ACCOUNTS, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic(clientId, clientSecret) },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }).toString(),
  })
  const j: any = await r.json().catch(() => ({}))
  if (!r.ok || !j.refresh_token) throw new Error(`Spotify code exchange: HTTP ${r.status} ${j.error_description ?? j.error ?? ''}`)
  return { refreshToken: j.refresh_token as string, accessToken: j.access_token as string }
}

/** Authenticated call with one polite retry on 429 (Retry-After, capped). */
async function api(token: string, path: string, init: RequestInit = {}, retried = false): Promise<any> {
  const r = await fetch(`${API}${path}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, 'content-type': 'application/json' } })
  if (r.status === 429 && !retried) {
    const wait = Math.min(10, Number(r.headers.get('retry-after') ?? 1)) * 1000
    await new Promise((res) => setTimeout(res, wait))
    return api(token, path, init, true)
  }
  if (r.status === 204) return null
  const text = await r.text()
  let j: any = null
  try { j = text ? JSON.parse(text) : null } catch { /* keep text */ }
  if (!r.ok) throw Object.assign(new Error(`Spotify ${path.split('?')[0]}: HTTP ${r.status} ${j?.error?.message ?? text.slice(0, 120)}`), { status: r.status })
  return j
}

export async function spotifyMe(token: string): Promise<{ id: string; displayName: string }> {
  const j = await api(token, '/me')
  return { id: j.id, displayName: j.display_name ?? j.id }
}

/** Track search. No `market` param: with a user token Spotify applies the account's own
 *  country anyway, and `market=from_token` would need the user-read-private scope. */
export async function searchTracks(token: string, q: string, limit = 6): Promise<SpotifyCandidate[]> {
  const j = await api(token, `/search?${new URLSearchParams({ q, type: 'track', limit: String(limit) })}`)
  const items: any[] = j?.tracks?.items ?? []
  return items.map((t) => ({ id: t.id, name: t.name, artists: (t.artists ?? []).map((a: any) => a.name) }))
}

const chunk = <T,>(xs: T[], n: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

// Library endpoints (Feb 2026): the old /me/tracks + /me/tracks/contains now answer a bare
// 403. The replacements take up to 40 `spotify:track:` URIs as a query parameter.
const uriQuery = (ids: string[]) => new URLSearchParams({ uris: ids.map((id) => `spotify:track:${id}`).join(',') }).toString()

/** Which of these ids are already in Liked Songs (same order as input). */
export async function alreadySaved(token: string, ids: string[]): Promise<boolean[]> {
  const out: boolean[] = []
  for (const c of chunk(ids, 40)) {
    const j = await api(token, `/me/library/contains?${uriQuery(c)}`)
    out.push(...(Array.isArray(j) ? j.map(Boolean) : c.map(() => false)))
  }
  return out
}

/** Add to Liked Songs. Idempotent on Spotify's side. */
export async function saveTracks(token: string, ids: string[]): Promise<void> {
  for (const c of chunk(ids, 40)) await api(token, `/me/library?${uriQuery(c)}`, { method: 'PUT' })
}
