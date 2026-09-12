/**
 * src/match.ts — pure track-matching core for the NTS → Spotify sync.
 *
 * No I/O here so it can be unit-tested (test/sync.test.ts). Given an NTS
 * saved track (title + artist names) and Spotify search hits, decide which hit — if
 * any — is THE SAME VERSION of the recording. The bar is deliberately high: a remix,
 * edit, dub, live take or instrumental is a different track, so version tags must
 * agree exactly and the title must be a near-exact match after normalisation. When
 * nothing clears the bar we return null; the caller reports "not found" rather than
 * falling back to a lookalike.
 */

export interface NtsTrack {
  uid: string
  title: string
  artists: string[]
  savedAt: string // ISO
}

export interface SpotifyCandidate {
  id: string
  name: string
  artists: string[]
}

/** Lower-case, strip diacritics + punctuation, unify "&"/"feat.", collapse whitespace. */
export function normalise(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // Latin accents only — then recompose so kana voicing marks survive
    .normalize('NFC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(featuring|feat|ft)\.?(?=\s|$)/g, ' feat ')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ') // keep letters/digits of every script (Japanese titles are common on NTS)
    .trim()
    .replace(/\s+/g, ' ')
}

/** NTS truncates long titles with "..." / "…". Returns the untruncated prefix, or null. */
export function truncatedPrefix(title: string): string | null {
  const m = title.trim().match(/^(.*?)\s*(?:\.\.\.|…)$/)
  return m && m[1].trim() ? m[1].trim() : null
}

/** Remove "feat. X" / "(with X)" guest clauses only — Spotify tends to put guests in the
 *  title, NTS in the artist list. Version qualifiers ("(Dub Mix)", "- Live") are NOT
 *  removed: they matter. */
export function stripFeat(title: string): string {
  const t = title
    .replace(/\s*[([{]\s*(?:feat|ft|featuring|with)\.?\s[^)\]}]*[)\]}]/gi, '')
    .replace(/\s+(?:feat|ft|featuring)\.?\s.*$/i, '')
    .trim()
  return t || title
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>()
  const t = ` ${s} `
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2)
    m.set(g, (m.get(g) ?? 0) + 1)
  }
  return m
}

/** Bigram Dice coefficient in [0, 1]. Tolerates a typo or punctuation drift, not more. */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const ga = bigrams(a)
  const gb = bigrams(b)
  let overlap = 0
  let na = 0
  let nb = 0
  for (const v of ga.values()) na += v
  for (const v of gb.values()) nb += v
  for (const [g, v] of ga) overlap += Math.min(v, gb.get(g) ?? 0)
  return (2 * overlap) / (na + nb)
}

/** Split "A & B", "A feat. B", "A x B", "A, B" into individual artist names. */
export function splitArtists(names: string[]): string[] {
  const out: string[] = []
  for (const n of names) {
    for (const part of n.split(/\s*(?:,|&|\/|\bfeat\.?(?=\s)|\bft\.?(?=\s)|\bfeaturing\b|\bvs\.?(?=\s)|\bx\b|\bwith\b)\s*/i)) {
      const p = part.trim()
      if (p) out.push(p)
    }
  }
  return out.length ? out : names
}

// Words that name a *different version* of a recording. "original mix" / "remaster" are
// the same recording and are ignored; everything else must match on both sides. "mix" on
// its own is neutral — "(Dub Mix)" ≡ "(Dub)", "(Extended Mix)" ≡ "- Extended" — the word
// that distinguishes the version is the other one.
const QUALIFIERS = new Set(['remix', 'rmx', 'edit', 'dub', 'version', 'live', 'instrumental', 'acoustic', 'radio', 'extended', 'demo', 'alternate', 'alternative', 'rework', 'refix', 'bootleg', 'cover', 'vip', 'reprise', 'unplugged', 'session', 'sessions', 'take', 'karaoke', 'slowed', 'reverb', 'sped'])
const NEUTRAL = new Set(['original', 'mix', 'remaster', 'remastered', 'mono', 'stereo', 'explicit', 'clean', 'album', 'single', 'lp', 'ep', 'bonus', 'track', 'edition', 'deluxe', 'anniversary', 'the', 'a', 'of', 'and', 'feat'])

/**
 * The set of version-defining words in a title: everything inside brackets or after a
 * " - " separator (minus neutral words like "original"/"remaster"), plus any qualifier
 * word in the main title ("Song Remix"). Two titles are the same version iff equal.
 */
export function versionTags(title: string): Set<string> {
  const t = stripFeat(title)
  const tags = new Set<string>()
  const segs: string[] = []
  const main = t
    .replace(/[([{]([^)\]}]*)[)\]}]/g, (_, inner: string) => { segs.push(inner); return ' ' })
    .replace(/\s+[-–—]\s+(.*)$/, (_, rest: string) => { segs.push(rest); return ' ' })
  for (const s of segs) {
    const words = normalise(s).split(' ').filter(Boolean)
    // "original mix" / "2011 remaster" → nothing; "club mix" → club; "four tet remix" → all three
    for (const w of words) if (!NEUTRAL.has(w) && !/^\d{4}$/.test(w)) tags.add(w)
  }
  for (const w of normalise(main).split(' ')) if (QUALIFIERS.has(w)) tags.add(w)
  return tags
}

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x))

/** Title similarity with bracketed/dashed qualifiers removed — the "core" title. */
function coreTitle(title: string): string {
  return normalise(stripFeat(title).replace(/[([{][^)\]}]*[)\]}]/g, ' ').replace(/\s+[-–—]\s+.*$/, ''))
}

function artistScore(nts: string[], sp: string[]): number {
  const a = splitArtists(nts).map(normalise).filter(Boolean)
  const b = splitArtists(sp).map(normalise).filter(Boolean)
  if (!a.length || !b.length) return 0
  let best = 0
  for (const x of a) {
    for (const y of b) {
      const s = x === y ? 1 : x.includes(y) || y.includes(x) ? 0.9 : similarity(x, y)
      if (s > best) best = s
    }
  }
  return best
}

export interface MatchScore { score: number; title: number; artist: number; sameVersion: boolean }

/** Confidence that `c` is the very same version NTS logged as `t`. */
export function scoreCandidate(t: NtsTrack, c: SpotifyCandidate): MatchScore {
  const artist = artistScore(t.artists, c.artists)
  const prefix = truncatedPrefix(t.title)
  if (prefix) {
    // NTS cut the title short: accept only a Spotify title that starts with what we have AND
    // carries no version tag of its own (a remix hidden past the "..." can't be ruled out otherwise).
    const p = normalise(stripFeat(prefix))
    const full = normalise(stripFeat(c.name))
    const title = p.length >= 8 && full.startsWith(p) ? 1 : 0
    const sameVersion = versionTags(c.name).size === 0
    return { sameVersion, title, artist, score: sameVersion ? title * 0.6 + artist * 0.4 : 0 }
  }
  const sameVersion = sameSet(versionTags(t.title), versionTags(c.name))
  const title = Math.max(similarity(normalise(stripFeat(t.title)), normalise(stripFeat(c.name))), similarity(coreTitle(t.title), coreTitle(c.name)))
  return { sameVersion, title, artist, score: sameVersion ? title * 0.6 + artist * 0.4 : 0 }
}

/** Gates: identical version tags, title ≥ 0.9, artist ≥ 0.75 (covers!), blend ≥ 0.9. */
export const GATES = { title: 0.9, artist: 0.75, score: 0.9 }

/** Best candidate that clears every gate, else null — never a "close enough" fallback. */
export function pickBest(t: NtsTrack, cands: SpotifyCandidate[], gates = GATES): { pick: SpotifyCandidate; score: number } | null {
  let best: { pick: SpotifyCandidate; score: number } | null = null
  for (const c of cands) {
    const s = scoreCandidate(t, c)
    if (!s.sameVersion || s.title < gates.title || s.artist < gates.artist || s.score < gates.score) continue
    if (!best || s.score > best.score) best = { pick: c, score: s.score }
  }
  return best
}

/** Search strings to try in order — fielded first (precise), then free text with the same
 *  words. Each hit is still gated by pickBest, so a broader query can't pick a wrong track. */
export function buildQueries(t: NtsTrack): string[] {
  const title = stripFeat(truncatedPrefix(t.title) ?? t.title).trim()
  const artists = splitArtists(t.artists)
  const lead = artists[0] ?? ''
  const q = (s: string) => s.replace(/"/g, '').replace(/\s+/g, ' ').trim()
  const out = [
    lead ? `track:"${q(title)}" artist:"${q(lead)}"` : '',
    lead ? q(`${title} ${lead}`) : '',
    q(`${t.title} ${t.artists.join(' ')}`),
  ]
  return [...new Set(out.filter(Boolean))]
}

/** Accept a Spotify track id, `spotify:track:` URI or open.spotify.com URL → bare id. */
export function parseSpotifyTrackId(s: string): string | null {
  const m = s.trim().match(/^(?:spotify:track:|(?:https?:\/\/)?open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/)?([A-Za-z0-9]{22})(?:[?#].*)?$/)
  return m ? m[1] : null
}
