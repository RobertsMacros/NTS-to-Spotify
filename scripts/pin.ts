/**
 * Resolve a track the sync couldn't find, by hand (local state):
 *   npm run pin -- <ntsUid> <spotify track url | uri | id>
 * The uid is printed by `npm run sync` under "not on Spotify".
 */
import { pinMatches } from '../src/sync'
import { env, store } from './shared'

const [uid, ref] = process.argv.slice(2)
if (!uid || !ref) { console.error('usage: npm run pin -- <ntsUid> <spotify track url>'); process.exit(2) }
const r = await pinMatches(env, store, { [uid]: ref })
if (r.pinned.length) console.log(`✓ pinned ${uid} → liked on Spotify`)
else { console.error(`✗ rejected: ${uid} is not an unmatched/pending track, or the reference is not a Spotify *track* link`); process.exit(1) }
