/**
 * Run the sync on this computer:
 *   npm run sync          # incremental — what's new since last time
 *   npm run sync:full     # forget the cursors: re-walk every NTS saved track, retry every unmatched one
 *
 * Secrets come from .dev.vars (written by `npm run setup`) or the environment. State lives in
 * ~/.config/nts-to-spotify/state.json (override with $NTS_SPOTIFY_STATE). Pair with
 * scripts/com.robertsmacros.ntstospotify.plist.example for a Mac launchd timer. Same engine as
 * the optional Cloudflare Worker (src/worker.ts) — src/sync.ts.
 */
import { runSync } from '../src/sync'
import { env, store } from './shared'

const full = process.argv.includes('--full')
const report = await runSync(env, store, { full, log: (l) => console.log(`[nts-to-spotify] ${l}`) })
console.log(`[nts-to-spotify] added ${report.added}, already liked ${report.alreadyLiked}, unmatched ${report.unmatched}, pending ${report.pending} (${report.ms} ms)`)
if (report.unmatchedTracks.length) {
  console.log('[nts-to-spotify] not on Spotify (resolve by hand: npm run pin -- <uid> <spotify track url>):')
  for (const u of report.unmatchedTracks) console.log(`    ${u.uid}  ${u.artists} – ${u.title}  (${u.tries} tries${u.lastError ? `, ${u.lastError}` : ''})`)
}
if (report.skipped) console.log(`[nts-to-spotify] skipped: ${report.skipped}`)
if (report.error) { console.error(`[nts-to-spotify] ${report.error}`); process.exit(1) }
