/**
 * Why wasn't a track matched? Runs the same Spotify searches the sync runs and prints the
 * top hits with each gate's verdict, so a miss can be checked by eye.
 *
 *   npm run why              # every track currently marked "not on Spotify"
 *   npm run why -- <uid>     # just one
 */
import { buildQueries, GATES, scoreCandidate, type NtsTrack } from '../src/match'
import { searchTracks, spotifyAccessToken } from '../src/spotify'
import { env, store } from './shared'

const only = process.argv[2]
const state = await store.get()
if (!state) { console.error('no state yet — run `npm run sync` first'); process.exit(1) }
const targets: NtsTrack[] = Object.entries(state.unmatched)
  .filter(([uid]) => !only || uid === only)
  .map(([uid, u]) => ({ uid, title: u.title, artists: u.artists, savedAt: u.savedAt }))
if (!targets.length) { console.log(only ? `${only} is not in the unmatched list` : 'nothing is marked "not on Spotify"'); process.exit(0) }

const token = await spotifyAccessToken({ clientId: env.SPOTIFY_CLIENT_ID!, clientSecret: env.SPOTIFY_CLIENT_SECRET!, refreshToken: env.SPOTIFY_REFRESH_TOKEN! })
const pct = (n: number) => `${Math.round(n * 100)}%`
for (const t of targets) {
  console.log(`\n${t.artists.join(', ')} – ${t.title}   [${t.uid}]`)
  const seen = new Set<string>()
  let any = false
  for (const q of buildQueries(t)) {
    const hits = await searchTracks(token, q, 5)
    const fresh = hits.filter((h) => !seen.has(h.id))
    fresh.forEach((h) => seen.add(h.id))
    if (!fresh.length) continue
    any = true
    console.log(`  search: ${q}`)
    for (const h of fresh) {
      const s = scoreCandidate(t, h)
      const why = !s.sameVersion ? 'different version' : s.title < GATES.title ? `title ${pct(s.title)} < ${pct(GATES.title)}` : s.artist < GATES.artist ? `artist ${pct(s.artist)} < ${pct(GATES.artist)}` : s.score < GATES.score ? `score ${pct(s.score)}` : 'WOULD MATCH'
      console.log(`    ${why === 'WOULD MATCH' ? '✓' : '✗'} ${h.artists.join(', ')} – ${h.name}   (${why})   https://open.spotify.com/track/${h.id}`)
    }
  }
  if (!any) console.log('  Spotify returned no hits at all for any query')
}
console.log('\nA "WOULD MATCH" line means it will be liked on the next `npm run sync`. To accept another hit by hand: npm run pin -- <uid> <link>')
