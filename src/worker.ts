/**
 * src/worker.ts — optional Cloudflare Worker host: the sync runs every 15 minutes
 * (wrangler.jsonc `triggers.crons`) with no computer switched on.
 *
 *   GET  /status          what's synced, what's pending, what isn't on Spotify
 *   POST /run[?full=1]    run now (`?max=` raises the look-up cap on the paid plan)
 *   POST /pin             { "<ntsUid>": "<spotify track url>" } — resolve one by hand
 *
 * The Worker URL is public, so every request must carry `Authorization: Bearer <SYNC_TOKEN>`
 * (the setup script generates one). State lives in the KV namespace bound as STATE.
 */

import { clampCap, kvStore, pinMatches, runSync, syncStatus, type SyncEnv } from './sync'

interface Env extends SyncEnv {
  SYNC_TOKEN?: string
  STATE?: { get: (k: string, t?: string) => Promise<any>; put: (k: string, v: string) => Promise<void> }
}

// Per-invocation budget: ≤6 NTS pages + ≤10 Spotify look-ups (each ≤3 searches) + 2 token
// refreshes + contains + save ≈ 40 subrequests — inside the Workers free plan's 50. A backlog
// (the first run over your whole NTS history) drains over successive ticks, newest first.
const LOOKUPS_PER_RUN = 10
const PAGES_PER_RUN = 6

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

const authorised = (request: Request, env: Env) =>
  !!env.SYNC_TOKEN && request.headers.get('authorization') === `Bearer ${env.SYNC_TOKEN}`

export default {
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }): Promise<void> {
    ctx.waitUntil(runSync(env, kvStore({ KV: env.STATE }), { maxLookups: LOOKUPS_PER_RUN, maxPages: PAGES_PER_RUN, log: (l) => console.log(`[nts-to-spotify] ${l}`) }))
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.SYNC_TOKEN) return json({ error: 'SYNC_TOKEN secret is not set — run `npm run setup` and `npx wrangler secret bulk .dev.vars`' }, 503)
    if (!authorised(request, env)) return json({ error: 'unauthorised' }, 401)
    const url = new URL(request.url)
    const store = kvStore({ KV: env.STATE })
    try {
      if (url.pathname === '/status') return json(await syncStatus(env, store))
      if (request.method !== 'POST') return json({ error: 'use GET /status, POST /run or POST /pin' }, 405)
      if (url.pathname === '/run') {
        const max = clampCap(url.searchParams.get('max'), LOOKUPS_PER_RUN, 300)
        const report = await runSync(env, store, { full: url.searchParams.get('full') === '1', maxLookups: max, maxPages: PAGES_PER_RUN })
        return json(report, report.error ? 502 : 200)
      }
      if (url.pathname === '/pin') {
        const pins = await request.json().catch(() => null)
        if (!pins || typeof pins !== 'object') return json({ error: 'body must be { "<ntsUid>": "<spotify track url>" }' }, 400)
        return json(await pinMatches(env, store, pins as Record<string, string>))
      }
      return json({ error: 'not found' }, 404)
    } catch (e: any) {
      return json({ error: String(e?.message ?? e) }, 500)
    }
  },
}
