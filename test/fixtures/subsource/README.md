Real SubSource API responses (api.subsource.net/api/v1), captured 2026-10-18 with a free key.
The key is never part of a response (it only travels in the X-API-Key request header). Subtitle `preview` text and
contributor names are replaced with "[redacted]"; everything else is as received.

- `search-movie-tt0111161.json`: GET /movies/search?searchType=imdb&imdb=tt0111161
- `subtitles-movie-tt0111161-greek.json`: GET /subtitles?movieId=97027&language=greek&limit=100&sort=popular
- `search-series-tt0364845-s23.json`: GET /movies/search?searchType=imdb&imdb=tt0364845&season=23 (one movieId per season)
- `subtitles-series-tt0364845-s23-greek.json`: season 23 has NO Greek subtitles (empty list, total 0)
- `subtitles-series-ncis-s09-greek.json`: season 9 (movieId 63030), one Greek result whose release name carries the episode (`S09x03`)

Facts seen here: list rows have no season/episode field (the episode only appears inside `releaseInfo`), `releaseInfo` is an
array of strings, `link` is a web path, `files`/`size` are often null. Rate-limit headers: x-ratelimit-limit(-hour/-day),
x-ratelimit-remaining(-hour/-day), x-ratelimit-reset (ISO time), x-ratelimit-window.
