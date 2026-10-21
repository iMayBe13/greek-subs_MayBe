// Provider registry. To add a source: create a file exporting
//   { id, name, enabled(cfg), search(ctx) -> [{provider, ref, release, downloads, hashMatch?}], download({ref, cfg}) -> Buffer }
// then add it here. Add the id to PROVIDER_PRIORITY (earlier = preferred when duplicates collide).
import opensubtitles from './opensubtitles.js';
import subdl from './subdl.js';
import subsource from './subsource.js';
import greeksubs from './greeksubs.js';

export const providers = [greeksubs, opensubtitles, subdl, subsource];
export const byId = Object.fromEntries(providers.map((p) => [p.id, p]));
export const PROVIDER_PRIORITY = providers.map((p) => p.id);
