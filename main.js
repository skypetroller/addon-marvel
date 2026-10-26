import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import compression from 'compression';
import axios from 'axios';
import pLimit from 'p-limit';
import { LRUCache } from 'lru-cache';

import chronologicalData from './Data/chronologicalData.js';
import releaseData from './Data/releaseData.js';
import xmenData from './Data/xmenData.js';
import moviesData from './Data/moviesData.js';
import seriesData from './Data/seriesData.js';
import animationsData from './Data/animationsData.js';
import {
  buildMetadataEntry,
  isValidUrl,
  lookupIdFor,
  normalizeType,
  FALLBACK_POSTER,
} from './lib/metadata.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMDB_KEY = process.env.TMDB_API_KEY || '';
const OMDB_KEY = process.env.OMDB_API_KEY || '';
const PORT = Number(process.env.PORT || 7000);

const manifestTemplate = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf-8')
);

// Stremio caches catalog state per top-level manifest ID (see stremio-bugs
// #2806). A bumped version or catalog ID is not enough to clear it, so the
// addon uses a fresh ID to force clients to treat it as a new addon.
const ADDON_ID = 'com.skypetroller.marveluniverse.v2';

// Pre-built by scripts/buildMetadata.js. Read once at startup so normal
// catalog requests never touch TMDB or OMDb.
const METADATA_CACHE_PATH = path.join(__dirname, 'Data', 'metadataCache.json');
let metadataCache = {};
try {
  metadataCache = JSON.parse(fs.readFileSync(METADATA_CACHE_PATH, 'utf-8'));
  console.log(`Metadata cache loaded: ${Object.keys(metadataCache).length} entries.`);
} catch (err) {
  console.warn('No metadataCache.json found. Falling back to live metadata lookups.');
}

let lastUpdated = null;
try {
  lastUpdated = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'Data', 'lastUpdated.json'), 'utf-8')
  ).updatedAt;
} catch (err) {
  // Stamp file is created by the updater; absence is fine before the first run.
}

const app = express();
app.set('trust proxy', true);

app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Cache policy:
//   - Catalog payloads are cached for an hour (they change at most twice a week).
//   - Manifests, configure page, /health and /api/catalogs must always revalidate,
//     otherwise version bumps and freshness stamps get stuck in a CDN cache.
app.use((req, res, next) => {
  const isCatalogData =
    /^\/(catalog|rpdb)\//.test(req.path) &&
    req.path.endsWith('.json') &&
    !req.path.endsWith('manifest.json');
  res.setHeader('Cache-Control', isCatalogData ? 'public, max-age=3600' : 'no-cache');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// In-memory request counters so we can confirm whether a Stremio client is
// actually reaching this deployment after an install. Resets on restart.
const requestStats = {
  startedAt: new Date().toISOString(),
  manifests: 0,
  catalogs: 0,
  lastManifestAt: null,
  lastCatalogAt: null,
  lastUserAgent: null,
  clients: {},
};

function noteRequest(kind, req) {
  const ua = String(req.get('user-agent') || 'unknown').slice(0, 160);
  requestStats.lastUserAgent = ua;
  requestStats.clients[ua] = (requestStats.clients[ua] || 0) + 1;
  const clients = Object.keys(requestStats.clients);
  if (clients.length > 20) delete requestStats.clients[clients[0]];

  const now = new Date().toISOString();
  if (kind === 'manifest') {
    requestStats.manifests += 1;
    requestStats.lastManifestAt = now;
  } else {
    requestStats.catalogs += 1;
    requestStats.lastCatalogAt = now;
  }
}

app.use((req, res, next) => {
  if (req.path.endsWith('/manifest.json')) {
    noteRequest('manifest', req);
  } else if (/^\/(?:catalog|rpdb)\//.test(req.path) && req.path.endsWith('.json')) {
    noteRequest('catalog', req);
  }
  next();
});

// ---------------------------------------------------------------------------
// Catalog sources
// ---------------------------------------------------------------------------

// Stremio clients only render catalogs for the standard `movie` and `series`
// types reliably. The original addon used a custom `Marvel` type, which some
// clients (notably Android TV and several forks) silently drop. Keep the
// curated mixed lists intact, but expose them under the standard types.
const CATALOG_DEFS = [
  {
    id: 'marvel-mcu',
    name: 'MCU Chronologically Ordered',
    category: 'Timeline',
    description: 'The Marvel Cinematic Universe in story order',
    icon: 'shield-halved',
    type: 'movie',
  },
  {
    id: 'release-order',
    name: 'MCU Release Order',
    category: 'Timeline',
    description: 'The MCU in the order the films and shows were released',
    icon: 'calendar-days',
    type: 'movie',
  },
  {
    id: 'xmen',
    name: 'X-Men',
    category: 'Curated',
    description: 'The X-Men film series in release order',
    icon: 'xmen-logo',
    type: 'movie',
  },
  {
    id: 'movies',
    name: 'Movies',
    category: 'Content Type',
    description: 'Every Marvel movie in the catalog, oldest to newest',
    icon: 'film',
    type: 'movie',
  },
  {
    id: 'series',
    name: 'Series',
    category: 'Content Type',
    description: 'Live-action Marvel television series',
    icon: 'tv',
    type: 'series',
  },
  {
    id: 'animations',
    name: 'Animations',
    category: 'Content Type',
    description: 'Marvel animated films and series',
    icon: 'palette',
    type: 'movie',
  },
  {
    id: 'marvel-new',
    name: 'New Releases',
    category: 'Timeline',
    description: 'Marvel titles released or added in the last 120 days',
    icon: 'star',
    type: 'movie',
  },
  {
    id: 'marvel-upcoming',
    name: 'Coming Soon',
    category: 'Timeline',
    description: 'Announced Marvel titles with a confirmed future release date',
    icon: 'clock',
    type: 'movie',
  },
];

const DATA_SOURCES = {
  'marvel-mcu': () => chronologicalData,
  'release-order': () => releaseData,
  xmen: () => xmenData,
  movies: () => moviesData,
  series: () => seriesData,
  animations: () => animationsData,
};

function getAllUniqueItems() {
  const seen = new Map();
  for (const items of [
    chronologicalData,
    releaseData,
    xmenData,
    moviesData,
    seriesData,
    animationsData,
  ]) {
    for (const item of items) {
      const lookupId = lookupIdFor(item);
      if (lookupId && !seen.has(lookupId)) seen.set(lookupId, item);
    }
  }
  return [...seen.values()];
}

const ALL_ITEMS = getAllUniqueItems();

function releaseDateFor(item) {
  const cached = metadataCache[lookupIdFor(item)];
  return item.releaseDate || cached?.releaseDate || null;
}

function newReleaseSource() {
  const cutoff = Date.now() - 120 * 24 * 60 * 60 * 1000;
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set();
  return ALL_ITEMS.filter((item) => {
    const releaseDate = releaseDateFor(item);
    // Newly discovered titles use addedAt (even if they are still upcoming);
    // the initial backfill only counts titles that have already been released.
    const added =
      item.addedAt ||
      (releaseDate && releaseDate <= today ? releaseDate : null);
    if (!added) return false;
    if (new Date(added).getTime() < cutoff) return false;
    const lookupId = lookupIdFor(item);
    if (seen.has(lookupId)) return false;
    seen.add(lookupId);
    return true;
  }).sort((a, b) => {
    const da = new Date(a.addedAt || releaseDateFor(a) || 0);
    const db = new Date(b.addedAt || releaseDateFor(b) || 0);
    if (db - da !== 0) return db - da;
    return String(b.releaseDate || b.releaseYear || '').localeCompare(
      String(a.releaseDate || a.releaseYear || '')
    );
  });
}

function upcomingSource() {
  const today = new Date().toISOString().slice(0, 10);
  return ALL_ITEMS.filter((item) => {
    const releaseDate = releaseDateFor(item);
    return releaseDate && releaseDate > today;
  }).sort((a, b) => {
    const da = releaseDateFor(a) || '9999-12-31';
    const db = releaseDateFor(b) || '9999-12-31';
    return da.localeCompare(db) || String(a.title).localeCompare(String(b.title));
  });
}

const DYNAMIC_SOURCES = {
  'marvel-new': newReleaseSource,
  'marvel-upcoming': upcomingSource,
};

function resolveCatalogSource(id) {
  const staticSource = DATA_SOURCES[id];
  if (staticSource) {
    const items = staticSource();
    return Array.isArray(items) ? items : null;
  }
  const dynamicSource = DYNAMIC_SOURCES[id];
  if (dynamicSource) return dynamicSource();

  // Mixed catalogs are exposed as `<id>-movies` and `<id>-series` so every
  // Stremio catalog only contains items of its own type.
  const variant = String(id).match(/^(.*)-(movies|series)$/);
  if (variant) {
    const baseSource = resolveCatalogSource(variant[1]);
    if (baseSource) {
      const type = variant[2] === 'movies' ? 'movie' : 'series';
      return baseSource.filter((item) => normalizeType(item.type) === type);
    }
  }
  return null;
}

function catalogVariants() {
  const variants = [];
  for (const catalog of CATALOG_DEFS) {
    const source = resolveCatalogSource(catalog.id) || [];
    const types = new Set(
      source.map((item) => normalizeType(item.type)).filter(Boolean)
    );

    if (types.size <= 1) {
      variants.push({
        ...catalog,
        type: [...types][0] || catalog.type,
      });
      continue;
    }

    for (const type of ['movie', 'series']) {
      if (!types.has(type)) continue;
      variants.push({
        ...catalog,
        id: `${catalog.id}-${type === 'movie' ? 'movies' : 'series'}`,
        name: `${catalog.name} (${type === 'movie' ? 'Movies' : 'Series'})`,
        type,
      });
    }
  }
  return variants;
}

const catalogExtrasCache = {};

function getCatalogExtras(id) {
  if (catalogExtrasCache[id]) return catalogExtrasCache[id];

  let genres = [];
  try {
    const source = resolveCatalogSource(id) || [];
    const seen = new Set();
    source.forEach((item) => {
      const cached = metadataCache[lookupIdFor(item)];
      const values = cached?.genres || item.genres || [];
      values.forEach((genre) => {
        const name = typeof genre === 'string' ? genre : genre?.name;
        if (name) seen.add(name);
      });
    });
    genres = [...seen].sort((a, b) => a.localeCompare(b));
  } catch (err) {
    // Unknown/bad source: still expose search and paging.
  }

  const extras = [{ name: 'search' }, { name: 'skip' }];
  if (genres.length) extras.splice(1, 0, { name: 'genre', options: genres });
  catalogExtrasCache[id] = extras;
  return extras;
}

function getAllCatalogs() {
  return catalogVariants().map((catalog) => ({
    type: catalog.type,
    id: catalog.id,
    name: catalog.name,
    extra: getCatalogExtras(catalog.id),
  }));
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

function toStremioMeta(meta, item = null) {
  const lookupId = meta.id || lookupIdFor(item);
  const type = normalizeType(meta.type || item?.type);
  const name = String(meta.name || item?.title || 'Unknown');
  const genres = Array.isArray(meta.genres) ? [...new Set(meta.genres.filter(Boolean))] : [];
  const poster = meta.poster || item?.poster || FALLBACK_POSTER;
  const description = meta.description || item?.description || 'No description available.';
  const releaseInfo = String(meta.releaseInfo || item?.releaseYear || 'N/A');
  const imdbRating = meta.imdbRating && meta.imdbRating !== 'N/A' ? String(meta.imdbRating) : 'N/A';

  // Stremio's core deserializes `released` as a chrono DateTime, which rejects
  // a bare `YYYY-MM-DD`. One invalid item fails the whole catalog response and
  // the row renders empty, so always send a full ISO timestamp.
  const released = meta.releaseDate
    ? (/^\d{4}-\d{2}-\d{2}$/.test(String(meta.releaseDate))
        ? `${meta.releaseDate}T00:00:00.000Z`
        : String(meta.releaseDate))
    : null;

  return {
    id: lookupId,
    type,
    name: type === 'series' ? name.replace(/ Season \d+$/i, '') : name,
    ...(meta.logo ? { logo: meta.logo } : {}),
    poster,
    description,
    releaseInfo,
    ...(released ? { released } : {}),
    imdbRating,
    genres,
    ...(meta.trailer
      ? { trailers: [{ source: meta.trailer, type: 'Trailer' }] }
      : {}),
  };
}

const liveMetaLimit = pLimit(5);
const liveMetaCache = new LRUCache({ max: 500, ttl: 1000 * 60 * 60 * 24 });

async function fetchLiveMeta(item) {
  const lookupId = lookupIdFor(item);
  if (liveMetaCache.has(lookupId)) {
    return toStremioMeta(liveMetaCache.get(lookupId), item);
  }

  try {
    const entry = await liveMetaLimit(() =>
      buildMetadataEntry(item, {
        tmdbKey: TMDB_KEY,
        omdbKey: OMDB_KEY,
        existing: metadataCache[lookupId] || null,
      })
    );
    if (entry) {
      metadataCache[lookupId] = entry;
      liveMetaCache.set(lookupId, entry);
      return toStremioMeta(entry, item);
    }
  } catch (err) {
    console.warn(`Live metadata lookup failed for ${item.title}: ${err.message}`);
  }

  return toStremioMeta(
    {
      id: lookupId,
      type: normalizeType(item.type),
      name: item.title,
      poster: item.poster || FALLBACK_POSTER,
      description: item.description || 'No description available.',
      releaseInfo: item.releaseYear || 'N/A',
      imdbRating: 'N/A',
      genres: [],
    },
    item
  );
}

async function buildMetas(source) {
  const metas = await Promise.all(
    source.map((item) => {
      const lookupId = lookupIdFor(item);
      const cached = metadataCache[lookupId];
      if (cached) return Promise.resolve(toStremioMeta(cached, item));
      return fetchLiveMeta(item);
    })
  );
  return metas.filter(Boolean);
}

// ---------------------------------------------------------------------------
// RPDB posters
// ---------------------------------------------------------------------------

const rpdbValidityCache = new LRUCache({
  max: 20000,
  ttl: 1000 * 60 * 60 * 24,
});

async function isValidRpdbPoster(rpdbKey, imdbId) {
  if (!rpdbKey || !imdbId) return false;
  const cacheKey = `${rpdbKey}:${imdbId}`;
  if (rpdbValidityCache.has(cacheKey)) return rpdbValidityCache.get(cacheKey);

  let isValid = false;
  try {
    const res = await axios.head(
      `https://api.ratingposterdb.com/${rpdbKey}/imdb/poster-default/${imdbId}.jpg`,
      { timeout: 8000 }
    );
    isValid = res.status === 200;
  } catch (err) {
    isValid = false;
  }
  rpdbValidityCache.set(cacheKey, isValid);
  return isValid;
}

async function replaceRpdbPosters(rpdbKey, metas) {
  if (!rpdbKey) return metas;
  const limit = pLimit(8);
  return Promise.all(
    metas.map((meta) =>
      limit(async () => {
        const imdbId = meta.id?.startsWith('tt') ? meta.id : null;
        if (imdbId && (await isValidRpdbPoster(rpdbKey, imdbId))) {
          return {
            ...meta,
            poster: `https://api.ratingposterdb.com/${rpdbKey}/imdb/poster-default/${imdbId}.jpg`,
          };
        }
        return meta;
      })
    )
  );
}

// ---------------------------------------------------------------------------
// Catalog responses
// ---------------------------------------------------------------------------

const cachedCatalog = new LRUCache({
  max: 30,
  ttl: 1000 * 60 * 60 * 24 * 30,
  maxSize: 12_000_000,
  sizeCalculation: (value) => JSON.stringify(value).length,
});

function parseExtras(req) {
  const extras = Object.assign({}, req.query);
  if (req.params?.extra) {
    try {
      for (const [key, value] of new URLSearchParams(req.params.extra)) {
        extras[key] = value;
      }
    } catch (err) {
      // Malformed extras segment: ignore.
    }
  }
  return extras;
}

function extractRpdbKey(req, catalogsParam = null) {
  let key = req.params?.rpdbKey || req.query?.rpdb || null;

  if (!key && catalogsParam && catalogsParam.includes(':')) {
    key = catalogsParam.split(':').slice(1).join(':') || null;
  }

  if (!key) {
    const referer = req.get('Referrer') || '';
    const match = referer.match(/\/rpdb\/([^/]+)\/manifest\.json/);
    if (match?.[1]) key = decodeURIComponent(match[1]);
  }

  if (!key) return null;
  try {
    return decodeURIComponent(key);
  } catch (err) {
    return key;
  }
}

async function buildCatalogResponse(req, res, { id, rpdbKey }) {
  const extras = parseExtras(req);
  const skip = Math.max(0, parseInt(extras.skip, 10) || 0);
  const limit = Math.min(100, Math.max(1, parseInt(extras.limit, 10) || 100));
  const genre = extras.genre;
  const search = String(extras.search || '').trim().toLowerCase();

  try {
    let metas;
    const cacheKey = `catalog-${id}`;
    if (cachedCatalog.has(cacheKey)) {
      metas = cachedCatalog.get(cacheKey).metas;
    } else {
      const source = resolveCatalogSource(id);
      if (!source) {
        console.warn(`Unrecognized catalog ID: ${id}`);
        return res.json({ metas: [] });
      }
      metas = await buildMetas(source);
      cachedCatalog.set(cacheKey, { metas });
    }

    let filtered = metas;
    if (genre) {
      filtered = filtered.filter((meta) => Array.isArray(meta.genres) && meta.genres.includes(genre));
    }
    if (search) {
      filtered = filtered.filter((meta) => String(meta.name || '').toLowerCase().includes(search));
    }

    let page = filtered.slice(skip, skip + limit);
    if (rpdbKey) page = await replaceRpdbPosters(rpdbKey, page);

    return res.json({ metas: page });
  } catch (err) {
    console.error(`Catalog error for ${id}: ${err.message}`);
    return res.json({ metas: [] });
  }
}

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function buildManifest(req, { id, name, description, catalogs }) {
  return {
    ...manifestTemplate,
    id,
    name: name || manifestTemplate.name,
    description,
    catalogs,
    logo: `${baseUrl(req)}/assets/icon.png`,
    background: `${baseUrl(req)}/assets/background.jpg`,
  };
}

app.get('/manifest.json', (req, res) => {
  const rpdbKey = req.query.rpdb || null;
  const id = rpdbKey
    ? `${ADDON_ID}.rpdb.${String(rpdbKey).slice(0, 8)}`
    : ADDON_ID;

  res.json(
    buildManifest(req, {
      id,
      description: rpdbKey
        ? 'The entire Marvel catalog with IMDb ratings on posters! MCU, X-Men, movies, series and animations.'
        : 'The entire Marvel catalog! MCU and X-Men in curated order, plus movies, series and animations.',
      catalogs: getAllCatalogs(),
    })
  );
});

app.get('/rpdb/:rpdbKey/manifest.json', (req, res) => {
  const { rpdbKey } = req.params;
  res.json(
    buildManifest(req, {
      id: `${ADDON_ID}.rpdb.${String(rpdbKey).slice(0, 8)}`,
      description: 'The entire Marvel catalog with IMDb ratings on posters!',
      catalogs: getAllCatalogs(),
    })
  );
});

app.get('/catalog/:catalogsParam/manifest.json', (req, res) => {
  const { catalogsParam } = req.params;
  let selectedCatalogIds = catalogsParam;
  let rpdbKey = null;

  if (catalogsParam.includes(':') && !catalogsParam.endsWith(':')) {
    const [idsPart, ...keyParts] = catalogsParam.split(':');
    selectedCatalogIds = idsPart;
    rpdbKey = keyParts.join(':');
  }

  const ids = selectedCatalogIds.split(',').map((value) => value.trim()).filter(Boolean);
  const allCatalogs = getAllCatalogs();
  const selected = [];
  for (const id of ids) {
    const direct = allCatalogs.find((catalog) => catalog.id === id);
    if (direct) {
      selected.push(direct);
      continue;
    }
    // Backwards compatibility: old custom links selected the logical catalog
    // (e.g. `marvel-mcu`), which is now split into movie/series variants.
    selected.push(...allCatalogs.filter((catalog) => catalog.id.startsWith(`${id}-`)));
  }
  const uniqueSelected = [
    ...new Map(selected.map((catalog) => [catalog.id, catalog])).values(),
  ];
  if (!uniqueSelected.length) return res.status(404).send('No valid catalogs selected.');

  const customId = (
    rpdbKey
      ? `${ADDON_ID}.custom.${ids.join('.')}.rpdb`
      : `${ADDON_ID}.custom.${ids.join('.')}`
  ).slice(0, 100);

  res.json(
    buildManifest(req, {
      id: customId,
      name: 'Marvel Custom',
      description: `Your custom Marvel catalog: ${uniqueSelected.map((catalog) => catalog.name).join(', ')}`,
      catalogs: uniqueSelected,
    })
  );
});

// ---------------------------------------------------------------------------
// Pages and API
// ---------------------------------------------------------------------------

app.get('/catalog/:ids/configure', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

app.get('/configure', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

app.get('/api/catalogs', (req, res) => {
  const withCounts = catalogVariants().map((catalog) => {
    let count = 0;
    try {
      const source = resolveCatalogSource(catalog.id);
      count = source ? source.length : 0;
    } catch (err) {
      count = 0;
    }
    return { ...catalog, count };
  });
  res.json(withCounts);
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    version: manifestTemplate.version,
    updatedAt: lastUpdated,
    catalogs: catalogVariants().length,
    cachedTitles: Object.keys(metadataCache).length,
    requests: requestStats,
  });
});

// ---------------------------------------------------------------------------
// Catalog endpoints (default, custom, RPDB, path-style extras)
// ---------------------------------------------------------------------------

app.get('/rpdb/:rpdbKey/catalog/:type/:id.json', (req, res) =>
  buildCatalogResponse(req, res, {
    id: req.params.id,
    rpdbKey: extractRpdbKey(req),
  })
);

app.get('/catalog/:catalogsParam/catalog/:type/:id.json', (req, res) =>
  buildCatalogResponse(req, res, {
    id: req.params.id,
    rpdbKey: extractRpdbKey(req, req.params.catalogsParam),
  })
);

app.get('/catalog/:type/:id.json', (req, res) =>
  buildCatalogResponse(req, res, {
    id: req.params.id,
    rpdbKey: extractRpdbKey(req),
  })
);

app.get('/rpdb/:rpdbKey/catalog/:type/:id/:extra.json', (req, res) =>
  buildCatalogResponse(req, res, {
    id: req.params.id,
    rpdbKey: extractRpdbKey(req),
  })
);

app.get('/catalog/:catalogsParam/catalog/:type/:id/:extra.json', (req, res) =>
  buildCatalogResponse(req, res, {
    id: req.params.id,
    rpdbKey: extractRpdbKey(req, req.params.catalogsParam),
  })
);

app.get('/catalog/:type/:id/:extra.json', (req, res) =>
  buildCatalogResponse(req, res, {
    id: req.params.id,
    rpdbKey: extractRpdbKey(req),
  })
);

app.get('/', (req, res) => res.redirect('/configure'));

app.listen(PORT, () => {
  console.log(`Marvel Addon running at http://localhost:${PORT}/`);
  console.log(`Configure page: http://localhost:${PORT}/configure`);
  console.log(`TMDB key: ${TMDB_KEY ? 'configured' : 'missing (live fallback disabled)'}`);
  console.log(`OMDb key: ${OMDB_KEY ? 'configured' : 'missing (IMDb ratings fall back to TMDB)'}`);
});

export { app, buildCatalogResponse, toStremioMeta };
