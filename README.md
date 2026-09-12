# NTS to Spotify

*A Roberts macro — no macro too micro.*

Heart a track on NTS (the app or nts.live) and it turns up in your Spotify **Liked
Songs**. The exact recording only: a remix, edit, dub, live take or cover is never
substituted. If Spotify doesn't have that version, nothing is added and you get a push
saying so.

```
NTS "My Tracks"  ──▶  match (same version? same artist? near-exact title?)  ──▶  Spotify Liked Songs
                                          │
                                          └──▶  not found → push: "Not on Spotify: Artist – Title"
```

Two ways to run it. On your Mac, on a timer (simplest). Or on a free Cloudflare Worker,
every 15 minutes, with nothing switched on.

## Install (about five minutes)

**You need**

- Node 18 or newer (`node -v`). Get it from <https://nodejs.org> if not.
- A Spotify account with **Premium** (Spotify requires it for personal API apps since
  February 2026).
- Your NTS email and **password**. If you signed up to NTS with Google or Apple, use
  *Forgot password* on nts.live once to set one for the same email.

**1. Get the code**

```bash
git clone https://github.com/RobertsMacros/NTS-to-Spotify.git
cd NTS-to-Spotify
npm install
```

**2. Create a Spotify app** at <https://developer.spotify.com/dashboard>: *Create app* →
any name → type *Web API* → redirect URI exactly `http://127.0.0.1:8888/callback` → save.
Copy its *Client ID* and *Client secret*.

**3. Connect both accounts**

```bash
npm run setup
```

It signs in to NTS and shows your three most recent saved tracks (so you know it's the
right account), opens Spotify's consent page in your browser, optionally takes an
[ntfy](https://ntfy.sh) topic for the "not on Spotify" pushes, and writes everything to
the gitignored `.dev.vars`.

**4. First sync**

```bash
npm run sync
```

Walks your whole NTS history, prints every match (`✓`) and every miss (`✗`), then a
summary. Open Spotify → Liked Songs and check.

## Use

### Keep it running on your Mac

Copy `scripts/com.robertsmacros.ntstospotify.plist.example` to
`~/Library/LaunchAgents/com.robertsmacros.ntstospotify.plist`, edit the two paths in
it, then:

```bash
launchctl load ~/Library/LaunchAgents/com.robertsmacros.ntstospotify.plist
```

It runs every 15 minutes while the Mac is awake and logs to
`~/Library/Logs/nts-to-spotify.log`.

### Or run it on Cloudflare (nothing switched on)

Free tier is plenty. One-off:

```bash
npx wrangler login
npx wrangler kv namespace create STATE     # paste the id it prints into wrangler.jsonc
npm run deploy                             # uploads .dev.vars as secrets + deploys the cron
```

Then it just runs. To look at it from anywhere (the token is `SYNC_TOKEN` in `.dev.vars`):

| | |
| --- | --- |
| `GET /status` | last run, synced / pending counts, 20 most recent, the **not on Spotify** list |
| `POST /run` | run now (`?full=1` re-walks everything; `?max=40` more look-ups per run on the paid plan) |
| `POST /pin` `{"<ntsUid>":"<spotify track url>"}` | resolve a track by hand |

```bash
curl -H "Authorization: Bearer $SYNC_TOKEN" https://nts-to-spotify.<you>.workers.dev/status
```

### Everyday commands

| | |
| --- | --- |
| `npm run sync` | sync what's new since last time |
| `npm run sync:full` | re-walk every NTS saved track and retry every miss |
| `npm run why` | for every miss, the Spotify hits it saw and why each was rejected |
| `npm run pin -- <uid> <spotify track url>` | a track it couldn't find: tell it which one, it likes it and remembers |
| `npm test` | 32 tests: the matcher's gates and end-to-end runs against a fake NTS + Spotify |

The uid for `pin` is printed under "not on Spotify" by `npm run sync` (or in `/status`).

## How it decides a match

Every Spotify search hit has to clear all of these, or it's a miss:

- **Same version.** Words that name a version — remix, edit, dub, live, instrumental,
  extended, radio, VIP, rework… — must be identical on both sides. "Original Mix" and
  "Remaster" count as the same recording.
- **Near-exact title** after normalising accents, punctuation and where "feat." sits
  (any script — Japanese titles are fine). A title NTS cut short with "…" matches by
  prefix, but only a Spotify title with no version tag of its own.
- **The artist matches** (so a cover is rejected).

Nothing clears the bar → recorded as *not on Spotify*, one push, and it's quietly
re-checked after 1, 3, 7 and 30 days in case Spotify adds it. It never falls back to a
lookalike.

## How it works

- **NTS** has no public API for saved tracks. Its website reads them from a Firebase
  function; this does exactly what the site does with a long-lived refresh token for your
  account. Saving in the app and on the web both land in the same My NTS account.
- **State** is one JSON blob (`~/.config/nts-to-spotify/state.json` locally, a KV key on
  the Worker): a `pending` queue, `synced`, `unmatched`, and two NTS cursors. Each run
  reads NTS only down to the newest track it already knows — normally one page.
- **Budgeted.** The Worker reads at most 6 NTS pages and does 10 look-ups per run (newest
  saves first) to stay inside Cloudflare's per-invocation limit; a first-run backlog
  drains over successive ticks. The local runner has no cap.
- **Loss-proof.** A track leaves the queue only once its outcome is recorded; a failed
  Spotify call leaves it queued. A state-read failure aborts the run without writing.
- It only ever **adds** to Liked Songs. Un-saving on NTS does not remove from Spotify.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `NTS sign-in failed: INVALID_LOGIN_CREDENTIALS` | Google/Apple sign-up → set a password via *Forgot password* on nts.live |
| Spotify consent page says "INVALID_CLIENT: Invalid redirect URI" | the app's redirect URI must be exactly `http://127.0.0.1:8888/callback` |
| Every run: `Spotify /search: HTTP 403` | Spotify Premium lapsed (required for developer apps) |
| Push "NTS to Spotify sync failed: NTS token refresh …" | you changed your NTS password — `npm run setup` again |
| A track is a miss but you know it's on Spotify | `npm run pin -- <uid> <spotify track url>` |

Revoke access any time: change your NTS password; remove the app at
<https://www.spotify.com/account/apps/>.

## Files

- `src/match.ts` — the matcher (version tags, gates). Pure; tests in `test/sync.test.ts`.
- `src/nts.ts`, `src/spotify.ts` — the two clients.
- `src/sync.ts` — orchestration, state, retries, pins, pushes.
- `src/worker.ts` — the optional Cloudflare host (cron + `/status`, `/run`, `/pin`).
- `scripts/setup.mjs` — one-off account linking. `scripts/sync.ts`, `scripts/pin.ts` — local commands.
