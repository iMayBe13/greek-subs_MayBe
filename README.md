# Greek Subs

A self-hosted [Stremio](https://www.stremio.com/) add-on that finds **Greek subtitles** for movies and series. It searches
several sources at once, removes duplicates, ranks what is left against the file you are playing, and serves every
subtitle as clean UTF-8 `.srt` from its own server.

**Made by MayBe.**

## What it does

- Searches every enabled source in parallel. Each source has its own time limit, so a slow or broken source never holds
  up the others.
- Collapses re-uploads of the same subtitle and ranks the rest: a release name that matches the playing file first,
  then downloads and source.
- Opens zip archives and season packs and picks the right episode.
- Converts legacy Greek encodings (Windows-1253, ISO-8859-7, UTF-16) to UTF-8.
- Caches converted files on disk, so the same subtitle is not downloaded twice.

## Sources

| Source | What you need |
|---|---|
| GreekSubs.net | nothing (on by default) |
| OpenSubtitles (api.opensubtitles.com) | your API key; add your username and password to use your account's daily download quota |
| SubDL | your API key |
| SubSource | your API key |

Sites behind bot checks or captchas are not supported. The add-on does not try to get around them.

## Your keys

Each person opens `/configure`, enters their own keys and gets a personal install link. The keys are encrypted with
AES-256-GCM, using the server's `SECRET`, and sealed into that link. The server keeps no database or file of keys and
never logs them: it reads them from the link on each request, and an AI translation job holds them in memory only while
it runs.

- Anyone who has your install link can use your keys. Keep it private.
- Changing `SECRET` makes every existing install link stop working.
- Each person should use their own API keys. Do not run it as a public service that pools many users through one
  shared account or IP.
- "Test my keys" on the configure page would let anyone check credentials from your server's IP, so the endpoint behind
  it is on only in local development. On a hosted server set `ENABLE_KEY_TEST=1` to turn it on; it is rate limited
  per client (10 a minute) either way, and the button hides itself when it is off.
- Downloads and archives have size limits (see Limits and cache cleanup).

## Optional AI translation (always labelled)

When no Greek subtitle exists for a title and your link holds a DeepL key, a Gemini key or both, the list shows one
extra entry, `Ελληνικά (AI)`. Choosing it translates the English subtitle: DeepL makes a draft and Gemini polishes it,
with a per-show glossary of names (with only one of the two keys, that service does the whole translation). A first
version is served within seconds and improves as polished parts finish.

- It runs on your own DeepL and Gemini keys and their quotas. Nothing is shared between users.
- Every AI translation is labelled: its first cue says, in Greek and English, that it is an AI translation, and its
  Stremio entry id contains "AI". The configure page explains this too.
- Machine translation can contain errors (names, gender, idioms). Prefer a human subtitle when one exists: once a
  human Greek subtitle is found for the title, the AI entry is no longer listed.
- Finished translations are kept on disk, or in Cloudflare Workers KV when that is configured.

## Run locally

Requires Node.js 22.9 or newer.

```sh
npm install
cp .env.example .env    # then set SECRET (see below)
npm start               # or: npm run dev (restarts on changes)
npm test
```

Open <http://127.0.0.1:7000/configure>, enter your keys and install the link it gives you in Stremio. To use the add-on
from other devices, run it at a public https address (see Render below) and set `BASE_URL` to that address.

## Set a SECRET

Always set `SECRET` to a long random value (32+ characters); the server will not start without it. The only exception is
clear local development: `BASE_URL` unset or pointing at localhost, `127.0.0.1` or `::1`, and neither `RENDER` nor
`NODE_ENV=production` set. Anywhere else a missing or shorter `SECRET` stops the server at startup, because the code is
public and anyone could decrypt install links (and the API keys inside them) made with a guessable secret. A known
placeholder (`dev-only-secret`, or any value containing `change-me`) is refused the same way. `.env.example` leaves
`SECRET` empty on purpose. One way to make one:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Environment variables

| Name | Purpose |
|---|---|
| `SECRET` | Long random string (32+ characters, not a placeholder) that encrypts every install link. Empty in `.env.example`. Required everywhere except clear local development; keep it stable. |
| `BASE_URL` | Public URL of the server, no trailing slash. On Render it falls back to `RENDER_EXTERNAL_URL`. |
| `PORT` | Port to listen on (default 7000). |
| `CACHE_DIR` | Folder for cached subtitle files (default `./cache`). |
| `GREEKSUBS_BASE` | Base URL of GreekSubs.net (default `https://greeksubs.net`). |
| `ENABLE_KEY_TEST` | `1` or `0`: serve the "Test my keys" endpoint. Default: on for local development, off on a hosted server. |
| `TRUST_PROXY_HOPS` | How many proxies sit in front of the server (0 to 10), so rate limits see each visitor's own IP. Default 1 on Render, otherwise 0. See "Behind a proxy or Cloudflare". |
| `TRUST_CF_CONNECTING_IP` | `1` to take the visitor's IP from the `CF-Connecting-IP` header. Default off; read the warning below before turning it on. |
| `TRUST_PROXY` | Older setting, still works: any value except `0`, `false`, `off` or `no` means 1 hop. `TRUST_PROXY_HOPS` wins when both are set. |
| `CACHE_MAX_MB` | Size cap of the disk cache in MB (default 500, `0` = no cap). Oldest files go first. |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_KV_NAMESPACE_ID`, `CLOUDFLARE_API_TOKEN` | Optional, all three or none: keep AI translations in Cloudflare Workers KV instead of on disk. |
| `AI_CHUNK_CUES`, `AI_USER_DAILY`, `AI_GLOBAL_DAILY`, `AI_GEMINI_MODEL`, `AI_GEMINI_THINKING` | Optional AI translation tuning; see `.env.example`. |

`.env.example` lists every variable with its default. Never commit your `.env`.

## Behind a proxy or Cloudflare

The rate limits (10 a minute for the key test, 20 for creating links) count requests per visitor. Behind a reverse proxy
the server's own connection comes from the proxy, so it has to be told how many proxies to trust: the visitor's address
is then read from `X-Forwarded-For` that many steps from the end. Set it with `TRUST_PROXY_HOPS`.

| Setup | `TRUST_PROXY_HOPS` |
|---|---|
| Run locally, no proxy | `0` (the default) |
| Render, using its `onrender.com` address or a custom domain without Cloudflare | `1` (the default when `RENDER` is set) |
| Render with your own Cloudflare proxy in front of it (a proxied custom domain) | `2`: Cloudflare, then Render |
| Cloudflare Tunnel (`cloudflared`) next to the server | `1` |
| Another host or proxy | the number of proxies between the visitor and the server |

Too low and every visitor looks like the proxy, so one visitor's requests use up everybody's limit. Too high and a
visitor can send their own `X-Forwarded-For` and get a fresh limit each time. To check, use the add-on from two
devices: each should have its own limit. Hosting layouts change, so test it after you change the setup. The server prints
the value it uses at startup (`[proxy] trusting N proxy hop(s)`) and never logs visitor addresses.

Cloudflare also puts the visitor's address in a `CF-Connecting-IP` header. Set `TRUST_CF_CONNECTING_IP=1` to use it
(a missing or invalid header falls back to the hop count above). Only do this when every request really passes through
Cloudflare, for example behind a tunnel or with the server's address closed to everyone else. Anyone who can reach the
server directly, such as on a public `onrender.com` address next to a Cloudflare custom domain, can send any value
in that header and dodge the limits. When in doubt, leave it off and use the hop count.

## Limits and cache cleanup

- **Downloads:** a download over 15 MB is dropped while it is read, not after. A zip may have at most 1000 entries and
  50 MB unpacked in all, and an entry over 1 MB may not compress more than 100 to 1 (a zip bomb). A file over a limit is
  treated like a failed download: the subtitle is not served, the list still answers, and the log names the limit with
  numbers only, never a link or a key.
- **Disk cache:** expired files are removed at startup and then every hour, and when the cache folder is over
  `CACHE_MAX_MB` the oldest files are removed first. Only files this add-on wrote (a 40 character hex name ending in
  `.srt`, `.bin` or `.json`) are ever touched, so a shared `CACHE_DIR` is safe. Files go after 7 days (raw downloads),
  120 days (subtitle text, finished AI translations included) or 180 days (name glossaries), or sooner when the cache is
  over its size cap. A subtitle older than 30 days is fetched again the next time it is played.

## Deploy on Render

`render.yaml` describes one free Node web service with a `/health` check.

1. Fork this repository and create a new Blueprint on Render from it.
2. Fill in `SECRET`. Leave `BASE_URL` empty to use the address Render gives the service, or set your own.
3. Optionally fill in the three Cloudflare values.

On Render the proxy setting defaults to 1 hop and "Test my keys" is off. If you put your own Cloudflare proxy in front
of the service, set `TRUST_PROXY_HOPS=2` (see "Behind a proxy or Cloudflare").

The server refuses to start on Render without a real `SECRET` of 32+ characters. Free instances sleep when idle, so the first request after a
pause is slow, and the disk cache is lost on every restart or redeploy (Cloudflare KV keeps AI translations across them).

License: MIT
