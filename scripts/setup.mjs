#!/usr/bin/env node
/**
 * NTS → Spotify — one-off setup. Produces the secrets the sync needs and checks both
 * sides actually work before anything is stored. Node 18+, no deps.
 *
 *   npm run setup                      # = node scripts/setup.mjs --write → appends to .dev.vars
 *   node scripts/setup.mjs             # just prints the KEY=VALUE lines
 *
 * Steps:
 *   1. NTS   — email + password sign-in (Firebase) → long-lived refresh token, then a
 *              test read of your My Tracks so you can see it really is your account.
 *              Signed up to NTS with Google/Apple? Use NTS's "Forgot password" once to
 *              set a password for the same email, then run this.
 *   2. Spotify — opens the consent page for your own Spotify developer app (client id +
 *              secret from https://developer.spotify.com/dashboard, redirect URI
 *              http://127.0.0.1:8888/callback), catches the callback on a local server,
 *              exchanges it for a refresh token and checks /me.
 *   3. Optional — an ntfy.sh topic for "not on Spotify" pushes.
 *
 * Nothing is sent anywhere except NTS/Firebase and Spotify. The secrets are printed to
 * your terminal (and, with --write, appended to the gitignored .dev.vars). Then:
 *   npm run sync          (right now, on this computer)
 *   npm run deploy        (optional: every 15 min on Cloudflare — see README)
 */
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

const NTS_KEY = 'AIzaSyA4Qp5AvHC8Rev72-10-_DY614w_bxUCJU' // nts.live's public Firebase web key
const NTS_FN = 'https://europe-west2-nts-ios-app.cloudfunctions.net'
const REDIRECT = 'http://127.0.0.1:8888/callback'
const SCOPES = 'user-library-read user-library-modify'
const write = process.argv.includes('--write')

// Prompts: readline writes through a gate we can close, so a hidden prompt (password,
// client secret) shows the question but not the keystrokes — the classic mute-stream trick.
let muted = false
const gate = new Writable({
  write(chunk, _enc, cb) {
    if (!muted) process.stdout.write(chunk)
    cb()
  },
})
const rl = createInterface({ input: process.stdin, output: gate, terminal: !!process.stdin.isTTY })
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())))
const askHidden = (q) =>
  new Promise((res) => {
    process.stdout.write(q)
    muted = true
    rl.question('', (a) => {
      muted = false
      process.stdout.write('\n')
      res(a.trim())
    })
  })
const fail = (m) => { console.error(`\n✗ ${m}`); process.exit(1) }
const dotVars = () => {
  const out = {}
  if (existsSync('.dev.vars')) for (const l of readFileSync('.dev.vars', 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}
const existing = dotVars()

async function postJson(url, body, headers = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j?.error?.message ?? `HTTP ${r.status}`)
  return j
}

// ---------- 1. NTS ----------
console.log('\n── 1/3  NTS (My NTS account) ──')
const email = await ask('NTS email: ')
const password = await askHidden('NTS password (hidden): ')
let nts
try {
  nts = await postJson(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${NTS_KEY}`, { email, password, returnSecureToken: true })
} catch (e) {
  fail(`NTS sign-in failed: ${e.message}. (Google/Apple sign-up? Use "Forgot password" on nts.live to set a password first.)`)
}
try {
  const j = await postJson(`${NTS_FN}/getMyTracksEurope`, { data: { limit: 3 } }, { authorization: `Bearer ${nts.idToken}` })
  const rows = j?.result?.results ?? []
  if (!rows.length) console.log('✓ NTS signed in — no saved tracks yet (save one on nts.live and the sync will pick it up)')
  else {
    console.log('✓ NTS signed in — your most recent saved tracks:')
    for (const t of rows) console.log(`    • ${(t.artist_names ?? []).join(', ')} – ${t.song_title}`)
  }
} catch (e) {
  fail(`Signed in, but reading My Tracks failed: ${e.message}`)
}

// ---------- 2. Spotify ----------
console.log('\n── 2/3  Spotify ──')
console.log('Create an app at https://developer.spotify.com/dashboard (Web API) with redirect URI')
console.log(`  ${REDIRECT}\nthen paste its credentials here.`)
const clientId = (await ask(`Spotify client id${existing.SPOTIFY_CLIENT_ID ? ' [enter = keep .dev.vars]' : ''}: `)) || existing.SPOTIFY_CLIENT_ID
const clientSecret = (await askHidden(`Spotify client secret (hidden)${existing.SPOTIFY_CLIENT_SECRET ? ' [enter = keep .dev.vars]' : ''}: `)) || existing.SPOTIFY_CLIENT_SECRET
if (!clientId || !clientSecret) fail('client id and secret are required')

const state = randomBytes(12).toString('hex')
const authUrl = `https://accounts.spotify.com/authorize?${new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: REDIRECT, scope: SCOPES, state })}`
const code = await new Promise((res, rej) => {
  const srv = createServer((req, r) => {
    const u = new URL(req.url, REDIRECT)
    if (u.pathname !== '/callback') { r.writeHead(404).end(); return }
    const err = u.searchParams.get('error')
    if (err || u.searchParams.get('state') !== state) {
      r.writeHead(400).end(`Spotify auth failed: ${err ?? 'state mismatch'}`)
      srv.close()
      rej(new Error(err ?? 'state mismatch'))
      return
    }
    r.writeHead(200, { 'content-type': 'text/html' }).end('<p style="font:16px system-ui">✓ Spotify connected — you can close this tab.</p>')
    srv.close()
    res(u.searchParams.get('code'))
  })
  srv.listen(8888, '127.0.0.1', () => {
    console.log(`\nOpening Spotify consent in your browser… if it doesn't open, visit:\n  ${authUrl}\n`)
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    try { spawn(opener, [authUrl], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref() } catch { /* printed above */ }
  })
}).catch((e) => fail(`Spotify authorisation failed: ${e.message}`))
const basic = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
const tok = await fetch('https://accounts.spotify.com/api/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic },
  body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT }).toString(),
}).then((r) => r.json())
if (!tok.refresh_token) fail(`Spotify token exchange failed: ${tok.error_description ?? tok.error ?? 'no refresh token'}`)
const me = await fetch('https://api.spotify.com/v1/me', { headers: { authorization: `Bearer ${tok.access_token}` } }).then((r) => r.json())
console.log(`✓ Spotify connected as ${me.display_name ?? me.id}`)

// ---------- 3. Notifications (optional) ----------
console.log('\n── 3/3  "Not on Spotify" push (optional) ──')
console.log('Install the ntfy app (iOS/Android) or open https://ntfy.sh, subscribe to a private topic name,')
const topic = await ask('and type that topic name here (enter to skip): ')
rl.close()
const notifyUrl = topic ? (topic.startsWith('http') ? topic : `https://ntfy.sh/${topic}`) : ''
if (notifyUrl) {
  await fetch(notifyUrl, { method: 'POST', headers: { title: 'NTS to Spotify', tags: 'musical_note' }, body: 'Connected — you will get a push here when a saved track is not on Spotify.' }).catch(() => {})
  console.log(`✓ test push sent to ${notifyUrl}`)
}

// ---------- output ----------
const lines = [
  `NTS_REFRESH_TOKEN=${nts.refreshToken}`,
  `SPOTIFY_CLIENT_ID=${clientId}`,
  `SPOTIFY_CLIENT_SECRET=${clientSecret}`,
  `SPOTIFY_REFRESH_TOKEN=${tok.refresh_token}`,
  ...(notifyUrl ? [`NTS_NOTIFY_URL=${notifyUrl}`] : []),
  // Only used by the optional Cloudflare Worker: protects /status, /run and /pin.
  `SYNC_TOKEN=${existing.SYNC_TOKEN || randomBytes(24).toString('base64url')}`,
]
console.log('\n── Secrets (keep private; .dev.vars is gitignored) ──\n' + lines.join('\n'))
if (write) {
  appendFileSync('.dev.vars', `\n# generated ${new Date().toISOString().slice(0, 10)} by scripts/setup.mjs\n${lines.join('\n')}\n`)
  console.log('\n✓ written to .dev.vars')
}
console.log('\nNext:  npm run sync            (syncs your whole NTS history now, prints every match)')
console.log('Then:  npm run deploy          (optional — runs every 15 minutes on Cloudflare, see README)')
