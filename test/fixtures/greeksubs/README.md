# GreekSubs.net samples

Saved 2026-10-17 and trimmed to what `parseRows`, `parseSeriesIndex` and `secCodeOf` read: the subtitle table rows
(language image, download button, download counter, release name), the `secCode` input (value redacted) and, for the
series page, the episode and season-pack links of seasons 1, 23 and 24. Everything else of the site's pages is removed.

- `movie-tt0111161.html`: GET /en/view/tt0111161 (four Greek rows)
- `series-tt0364845.html`: GET /en/view/tt0364845 (series index)
- `episode-greekmtdb-episode-117.html`: GET /en/view/greekmtdb:episode:117 (one row)
- `pack-greekmtdb-season-92-23.html`: GET /en/view/greekmtdb:season:92:23 (one season-pack row)

`pack-s23-download.zip` (the real season 23 pack) is git-ignored third-party content; the tests that use it skip when it
is not on disk. Seen live: a download needs the session cookie and the secCode of the same page load (otherwise
HTTP 302 to /), and an unknown title returns HTTP 404.
