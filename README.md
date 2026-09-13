# NTS to Spotify

*A Roberts macro — no macro too micro.*

Heart a track on NTS (the app or nts.live) and it turns up in your Spotify **Liked
Songs** within fifteen minutes. The exact recording only: a remix, edit, dub, live
take or cover is never substituted. If Spotify doesn't have that version, nothing is
added and your phone tells you so.

```
NTS "My Tracks"  ──▶  match (same version? same artist? near-exact title?)  ──▶  Spotify Liked Songs
                                          │
                                          └──▶  not found → push: "Not on Spotify: Artist – Title"
```

## What you need

- **A Mac** and about fifteen minutes. Everything below happens in Terminal, one line
  at a time.
- **Spotify Premium.** Spotify requires it for personal apps like this one.
- **Your NTS email and password.** Signed up with Google or Apple? Use *Forgot
  password* on nts.live once to set one for the same email.
- **A free Cloudflare account** for the last step, so it runs with your laptop shut.
  (Skip it if you'd rather it ran on the Mac.)

## Setup

### 1. Install Node

Download the LTS version from <https://nodejs.org> and run the installer. Then open
Terminal and check it took:

```bash
node -v
```

Any number starting 18 or higher is fine.

### 2. Get the code

```bash
git clone https://github.com/RobertsMacros/NTS-to-Spotify.git
cd NTS-to-Spotify
npm install
```

If the first line asks to install "command line developer tools", say yes, wait for
it to finish, then run the line again.

### 3. Create your Spotify app

Go to <https://developer.spotify.com/dashboard>, log in with your Spotify account, and
click **Create app**. Give it any name, tick **Web API**, and set the Redirect URI to
exactly:

```
http://127.0.0.1:8888/callback
```

Save, open the app's settings, and keep the **Client ID** and **Client secret** to
hand for the next step.

### 4. Connect your accounts

```bash
npm run setup
```

It asks for your NTS email and password, then shows your three most recent NTS saves
so you know it's the right account. It opens Spotify in your browser to approve the
app, then asks for the Client ID and secret. Finally it offers a push-notification
topic, which is optional but worth having: install the free [ntfy](https://ntfy.sh)
app, subscribe to a made-up private topic name in it, and type that name here.

Your passwords stay on your Mac. The setup writes its keys into a file called
`.dev.vars` that never leaves the folder.

### 5. First sync

```bash
npm run sync
```

It walks through everything you've ever saved on NTS and prints a line per track: a
`✓` with the Spotify match, or a `✗` for anything Spotify doesn't have. Open Liked
Songs on Spotify and enjoy the scroll.

### 6. Make it run by itself

This puts it on Cloudflare's free tier, where it checks NTS every fifteen minutes
whether or not your Mac is on. A browser tab opens the first time to log in or create
the account; everything else is automatic.

```bash
npm run deploy
npm run state:push
```

The second command copies what your Mac already synced up to Cloudflare, so it
carries on from there rather than starting over. `npm run status` shows what it's
done since.

**Prefer to keep it on the Mac?** Copy
`scripts/com.robertsmacros.ntstospotify.plist.example` to
`~/Library/LaunchAgents/com.robertsmacros.ntstospotify.plist`, edit the two paths in
it, then `launchctl load` that file. It runs every fifteen minutes while the Mac is
awake and logs to `~/Library/Logs/nts-to-spotify.log`.

## Afterwards

Heart something on NTS, in the app or on the website, and it's in Liked Songs within
fifteen minutes. You get a push if a track isn't on Spotify, and one if the sync ever
breaks (for example after you change your NTS password: run `npm run setup` again,
then `npm run deploy`). Otherwise it's silent.

A few commands for the rare case where NTS has a title slightly wrong. Run them from
the `NTS-to-Spotify` folder:

| | |
| --- | --- |
| `npm run why` | For every track it couldn't match, shows what Spotify returned and why each hit was rejected. |
| `npm run find -- "Artist" "Title"` | Searches Spotify from the terminal and gives you links. |
| `npm run pin -- <id> <link>` | Tells it which track you meant. It likes it and stops asking. The id is printed next to the track by `why`. |
| `npm run state:push` | After pinning, sends the update up to Cloudflare. |
| `npm run sync:full` | Re-walk every NTS save and retry every miss now, rather than on the usual schedule. |

## How it decides a match

Every Spotify search hit has to clear all of these, or it's a miss:

- **Same version.** Words that name a version — remix, edit, dub, live, instrumental,
  extended, radio, VIP, rework… — must be identical on both sides. "Original Mix" and
  "Remaster" count as the same recording.
- **Near-exact title** after normalising accents, punctuation and where "feat." sits
  (any script, so Japanese titles are fine). A title NTS cut short with "…" matches by
  prefix, but only a Spotify title with no version tag of its own.
- **The artist matches.** A cover is rejected; an artist name one or two keystrokes
  off (a tracklist typo) is not, provided the title is exact.

Nothing clears the bar → recorded as *not on Spotify*, one push, and it's quietly
re-checked after 1, 3, 7 and 30 days in case Spotify adds it. It never falls back to
a lookalike.

## How it works

- **NTS** has no public API for saved tracks. Its website reads them from a Firebase
  function; this does exactly what the site does with a long-lived refresh token for
  your account. Saving in the app and on the web both land in the same My NTS account.
- **State** is one JSON blob (`~/.config/nts-to-spotify/state.json` on the Mac, a KV
  key on Cloudflare): a `pending` queue, `synced`, `unmatched`, and two NTS cursors.
  Each run reads NTS only down to the newest track it already knows — normally one page.
- **Budgeted.** The Worker reads at most 6 NTS pages and does 10 look-ups per run
  (newest saves first) to stay inside Cloudflare's per-invocation limit; a first-run
  backlog drains over successive ticks. The Mac runner has no cap.
- **Loss-proof.** A track leaves the queue only once its outcome is recorded; a failed
  Spotify call leaves it queued. A state-read failure aborts the run without writing.
- It only ever **adds** to Liked Songs. Un-saving on NTS does not remove from Spotify.
- **Cost:** nothing. Cloudflare's free tier allows 100,000 runs a day; this uses 96.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `NTS sign-in failed: INVALID_LOGIN_CREDENTIALS` | Google/Apple sign-up → set a password via *Forgot password* on nts.live |
| Spotify consent page says "INVALID_CLIENT: Invalid redirect URI" | the app's redirect URI must be exactly `http://127.0.0.1:8888/callback` |
| Every run: `Spotify /search: HTTP 403` | Spotify Premium lapsed (required for developer apps) |
| Push "NTS to Spotify sync failed: NTS token refresh …" | you changed your NTS password — `npm run setup` again, then `npm run deploy` |
| A track is a miss but you know it's on Spotify | `npm run why`, then `npm run pin -- <id> <link>` |

To stop it for good: delete the app at <https://www.spotify.com/account/apps/> and
change your NTS password.

## Files

- `src/match.ts` — the matcher (version tags, gates). Pure; tests in `test/sync.test.ts` (`npm test`).
- `src/nts.ts`, `src/spotify.ts` — the two clients.
- `src/sync.ts` — orchestration, state, retries, pins, pushes.
- `src/worker.ts` — the optional Cloudflare host (cron + `/status`, `/run`, `/pin`, bearer-token protected).
- `scripts/setup.mjs` — one-off account linking. `scripts/cf.mjs` — deploy, state push, status.
  `scripts/sync.ts`, `why.ts`, `find.ts`, `pin.ts` — everyday commands.
