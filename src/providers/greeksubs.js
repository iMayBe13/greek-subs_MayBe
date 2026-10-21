// GreekSubs.net - Greek-native, no API, no login. Verified live (see test/fixtures/greeksubs):
//  - /en/view/<id> works without the slug. Movies list rows directly. A series page is only an INDEX of links to
//    episode pages (own tt id, or greekmtdb:episode:N) and season-pack pages; match them by slug suffix.
//  - A row's button calls downloadMe('<subId>') -> GET /dll/<subId>/0/<secCode>. That needs the PHPSESSID cookie and
//    the secCode from the SAME page load, otherwise 302 -> /. So download() re-reads the page first.
//  - The download is a raw .srt (legacy Greek encoding) or a .zip season pack; archive.js + encoding.js handle both.
import * as cheerio from 'cheerio';
import { politeFetch } from '../lib/polite.js';
import { memGet, memSet, getCachedBuf, setCachedBuf, getCachedJson, setCachedJson } from '../lib/cache.js';
import { bestEntryName, listArchiveNames, isZip } from '../lib/archive.js';
import { readCapped } from '../lib/limits.js';

const base = () => (process.env.GREEKSUBS_BASE || 'https://greeksubs.net').replace(/\/$/, '');
const HOUR = 3600 * 1000;

// ---------- pure parsers (unit-tested against test/fixtures/greeksubs) ----------

/** Greek subtitle rows on a title/episode/pack page: [{ subId, release, downloads }] */
export function parseRows(html) {
  const $ = cheerio.load(html);
  const rows = [];
  $('tr').each((_, tr) => {
    const row = $(tr);
    const onclick = row.find('[onclick^="downloadMe"]').attr('onclick') || '';
    const subId = (onclick.match(/downloadMe\('([^']+)'\)/) || [])[1];
    if (!subId) return;
    if (String(row.find('img[alt]').first().attr('alt') || '').toLowerCase() !== 'el') return; // Greek only
    const label = row.find('.label-release').first();
    rows.push({
      subId,
      downloads: parseInt(label.text().replace(/[^\d]/g, ''), 10) || 0,
      release: label.closest('td').next('td').text().trim().replace(/\s+/g, ' '),
    });
  });
  return rows;
}

/** Episode and season-pack links on a series index page: [{ id, season, episode|null }] */
export function parseSeriesIndex(html) {
  const $ = cheerio.load(html);
  const seen = new Map();
  $('a[href*="/view/"]').each((_, a) => {
    let href = $(a).attr('href') || '';
    try { href = decodeURIComponent(href); } catch { /* keep raw */ }
    const id = (href.match(/\/view\/([^/?#]+)/) || [])[1];
    if (!id) return;
    const ep = href.match(/season-(\d+)-episode-(\d+)(?:$|[/?#])/);
    const pack = href.match(/season-(\d+)-complete-pack/);
    if (ep) seen.set(id, { id, season: Number(ep[1]), episode: Number(ep[2]) });
    else if (pack) seen.set(id, { id, season: Number(pack[1]), episode: null });
  });
  return [...seen.values()];
}

export const secCodeOf = (html) => (html.match(/value="([^"]+)"\s+id="secCode"/) || [])[1];

// ---------- site access ----------

async function getPage(id, stats) {
  stats.pages++;
  const res = await politeFetch(`${base()}/en/view/${id}`, { redirect: 'follow', timeoutMs: 6000 });
  if (res.status === 404) return { status: 404 };
  if (!res.ok) throw new Error(`GreekSubs page ${res.status}`);
  const html = await res.text();
  const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  return { status: 200, html, cookie, secCode: secCodeOf(html) };
}

async function getRows(id, stats) {
  const k = `gs:rows:${id}`;
  const hit = memGet(k);
  if (hit) { stats.cached++; return hit; }
  const page = await getPage(id, stats);
  const rows = page.status === 200 ? parseRows(page.html) : [];
  memSet(k, rows, HOUR);
  return rows;
}

async function getSeriesIndex(id, stats) {
  const k = `gs:index:${id}`;
  const hit = memGet(k);
  if (hit) { stats.cached++; return hit; }
  const page = await getPage(id, stats);
  const index = page.status === 200 ? parseSeriesIndex(page.html) : [];
  memSet(k, index, 12 * HOUR);
  return index;
}

const packKey = (ref) => `greeksubs-pack:${ref}`;

export default {
  id: 'greeksubs',
  name: 'GreekSubs',
  timeoutMs: 12000, // a cold series search reads 3 pages one at a time
  enabled: (cfg) => cfg?.enabled !== false, // no key needed; on by default

  async search({ type, imdbId, season, episode, filename, lang = 'el' }) {
    if (lang !== 'el') return []; // Greek-only site
    const t0 = Date.now();
    const stats = { pages: 0, cached: 0 };
    const tag = `${imdbId}${type === 'series' ? `:${season}:${episode}` : ''}`;
    let results = [];
    let note = '';
    try {
      if (type !== 'series') {
        const rows = await getRows(imdbId, stats);
        results = rows.map((r) => ({ provider: 'greeksubs', ref: `${imdbId}|${r.subId}`, release: r.release, downloads: r.downloads }));
      } else {
        const index = await getSeriesIndex(imdbId, stats);
        const epLink = index.find((l) => l.season === season && l.episode === episode);
        const packLink = index.find((l) => l.season === season && l.episode === null);
        if (!epLink && !packLink) note = ` (series page lists no S${season}E${episode} and no season ${season} pack)`;
        // Both pages are queued at once; politeFetch runs them one after the other.
        const [epRows, packRows] = await Promise.all([
          epLink ? getRows(epLink.id, stats) : [],
          packLink ? getRows(packLink.id, stats) : [],
        ]);
        results = epRows.map((r) => ({
          provider: 'greeksubs', ref: `${epLink.id}|${r.subId}`, release: r.release, downloads: r.downloads,
        }));
        for (const r of packRows) {
          const ref = `${packLink.id}|${r.subId}`;
          const names = await getCachedJson(packKey(ref)); // known once the pack has been downloaded
          let release = `${r.release.replace(/\.zip$/i, '')} (S${String(season).padStart(2, '0')} pack)`;
          let generic = true;
          if (names) {
            const best = bestEntryName(names, { season, episode, filename });
            if (!best) continue; // pack has no file for this episode
            release = best.split(/[\\/]/).pop();
            generic = false;
          }
          results.push({ provider: 'greeksubs', ref, release, downloads: r.downloads, pack: true, generic });
        }
      }
    } finally {
      console.log(`[greeksubs] ${tag} took ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
        `(${stats.pages} pages, ${stats.cached} from cache, ${results.length} results)${note}`);
    }
    return results;
  },

  // ref = "<pageId>|<subId>". Returns the raw .srt or .zip Buffer.
  async download({ ref }) {
    const cached = await getCachedBuf(`gs:${ref}`);
    if (cached) return cached;

    const [pageId, subId] = String(ref).split('|');
    if (!pageId || !subId) throw new Error('greeksubs: bad ref');
    const page = await getPage(pageId, { pages: 0, cached: 0 });
    if (page.status !== 200 || !page.secCode) throw new Error('greeksubs: page has no download code');
    const res = await politeFetch(`${base()}/dll/${encodeURIComponent(subId)}/0/${encodeURIComponent(page.secCode)}`, {
      headers: { Cookie: page.cookie, Referer: `${base()}/en/view/${pageId}` },
      redirect: 'manual',
      timeoutMs: 20000,
    });
    if (res.status !== 200) throw new Error(`greeksubs download blocked (HTTP ${res.status})`);
    const buf = await readCapped(res);
    if (buf[0] === 0x3c) throw new Error('greeksubs download returned a web page, not a subtitle'); // "<"

    await setCachedBuf(`gs:${ref}`, buf);
    if (isZip(buf)) await setCachedJson(packKey(ref), listArchiveNames(buf)); // remember inner names for ranking
    return buf;
  },
};
