/**
 * Search Spotify from the terminal — for when NTS has the title wrong and you want the
 * link to pin:   npm run find -- "Black Hearted Brother" "I Don't Mean To Wonder"
 */
import { searchTracks, spotifyAccessToken } from '../src/spotify'
import { env } from './shared'

const [artist, ...rest] = process.argv.slice(2)
const title = rest.join(' ')
if (!artist) { console.error('usage: npm run find -- "<artist>" "<title>"'); process.exit(2) }
const token = await spotifyAccessToken({ clientId: env.SPOTIFY_CLIENT_ID!, clientSecret: env.SPOTIFY_CLIENT_SECRET!, refreshToken: env.SPOTIFY_REFRESH_TOKEN! })
const q = title ? `track:"${title.replace(/["()[\]{}]/g, ' ')}" artist:"${artist.replace(/"/g, '')}"` : `artist:"${artist.replace(/"/g, '')}"`
const hits = await searchTracks(token, q, 10)
if (!hits.length) { console.log('no hits'); process.exit(0) }
for (const h of hits) console.log(`${h.artists.join(', ')} – ${h.name}   https://open.spotify.com/track/${h.id}`)
console.log('\nTo like one and mark the NTS track as done: npm run pin -- <ntsUid> <link>')
