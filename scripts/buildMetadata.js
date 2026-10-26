#!/usr/bin/env node
/**
 * Builds Data/metadataCache.json from TMDB + OMDb.
 *
 * Incremental by default: only new or incomplete items are fetched.
 *   node scripts/buildMetadata.js
 *   node scripts/buildMetadata.js --refresh
 *   node scripts/buildMetadata.js --refresh tt1270798,tt0371746
 *
 * The cache is committed to the repo and read by main.js at startup, so the
 * live addon never needs to hit TMDB/OMDb for titles that are already cached.
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pLimit from 'p-limit';

import chronologicalData from '../Data/chronologicalData.js';
import releaseData from '../Data/releaseData.js';
import xmenData from '../Data/xmenData.js';
import moviesData from '../Data/moviesData.js';
import seriesData from '../Data/seriesData.js';
import animationsData from '../Data/animationsData.js';
import {
  buildMetadataEntry,
  lookupIdFor,
  sameMetadata,
} from '../lib/metadata.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMDB_KEY = process.env.TMDB_API_KEY;
const OMDB_KEY = process.env.OMDB_API_KEY;

if (!TMDB_KEY) {
  console.error('CRITICAL: TMDB_API_KEY is not set (add it to .env or the environment).');
  process.exit(1);
}
if (!OMDB_KEY) {
  console.warn('WARNING: OMDB_API_KEY is not set. Ratings will fall back to TMDB vote averages.');
}

const DATA_DIR = path.join(__dirname, '..', 'Data');
const CACHE_PATH = path.join(DATA_DIR, 'metadataCache.json');

const dataSources = [
  chronologicalData,
  releaseData,
  xmenData,
  moviesData,
  seriesData,
  animationsData,
];

function collectAllItems() {
  const seen = new Map();
  for (const items of dataSources) {
    for (const item of items) {
      const lookupId = lookupIdFor(item);
      if (lookupId && !seen.has(lookupId)) seen.set(lookupId, item);
    }
  }
  return [...seen.values()];
}

function loadCache() {
  if (!fs.existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
  } catch (err) {
    console.warn('Existing metadata cache is invalid; starting fresh:', err.message);
    return {};
  }
}

function saveCache(cache) {
  const sorted = Object.fromEntries(
    Object.entries(cache).sort(([a], [b]) => a.localeCompare(b))
  );
  fs.writeFileSync(CACHE_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
}

function printCoverage(cache, allItems) {
  const values = Object.values(cache);
  const missing = allItems.filter((item) => !cache[lookupIdFor(item)]).length;
  const realDescriptions = values.filter(
    (entry) => entry.description && entry.description !== 'No description available.'
  ).length;
  const rated = values.filter(
    (entry) => entry.imdbRating && entry.imdbRating !== 'N/A'
  ).length;
  const withTmdbId = values.filter((entry) => entry.tmdbId).length;
  const withLogo = values.filter((entry) => entry.logo).length;
  const withTrailer = values.filter((entry) => entry.trailer).length;

  console.log('');
  console.log(`Catalog items: ${allItems.length}`);
  console.log(`Cache entries: ${values.length} (${missing} catalog items missing)`);
  console.log(`Real descriptions: ${realDescriptions}/${values.length}`);
  console.log(`Ratings: ${rated}/${values.length}`);
  console.log(`TMDB IDs: ${withTmdbId}/${values.length}`);
  console.log(`Logos: ${withLogo}/${values.length}`);
  console.log(`Trailers: ${withTrailer}/${values.length}`);
}

async function main() {
  const args = process.argv.slice(2);
  const forceRefresh = args.includes('--refresh');
  const explicitIdsArg = args.find((arg) => !arg.startsWith('--'));
  const explicitIds = explicitIdsArg
    ? explicitIdsArg.split(',').map((id) => id.trim()).filter(Boolean)
    : null;

  const allItems = collectAllItems();
  const cache = loadCache();

  const toProcess = allItems.filter((item) => {
    const lookupId = lookupIdFor(item);
    if (!lookupId) return false;
    if (explicitIds) return explicitIds.includes(lookupId);
    if (forceRefresh) return true;
    const existing = cache[lookupId];
    return (
      !existing ||
      !existing.tmdbId ||
      !existing.description ||
      existing.description === 'No description available.'
    );
  });

  console.log(`Unique catalog items: ${allItems.length}`);
  console.log(
    `Processing now: ${toProcess.length} (${forceRefresh ? 'forced refresh' : 'new/incomplete only'})`
  );

  if (toProcess.length === 0) {
    console.log('Nothing to do; cache is already up to date.');
    printCoverage(cache, allItems);
    return;
  }

  const limit = pLimit(4);
  let done = 0;

  const results = await Promise.all(
    toProcess.map((item) =>
      limit(async () => {
        const lookupId = lookupIdFor(item);
        const existing = cache[lookupId] || null;
        try {
          const entry = await buildMetadataEntry(item, {
            tmdbKey: TMDB_KEY,
            omdbKey: OMDB_KEY,
            existing,
          });
          done += 1;
          process.stdout.write(`\r${done}/${toProcess.length} processed`);
          if (!entry || !entry.id) return existing;

          // Preserve the old timestamp when nothing meaningful changed, so a
          // routine weekly run does not create a pointless version bump.
          if (existing && sameMetadata(existing, entry)) return existing;
          return entry;
        } catch (err) {
          done += 1;
          process.stdout.write(`\r${done}/${toProcess.length} processed`);
          console.warn(`\nFailed ${item.title} (${lookupId}): ${err.message}`);
          return existing;
        }
      })
    )
  );

  process.stdout.write('\n');

  for (const entry of results) {
    if (entry && entry.id) cache[entry.id] = entry;
  }

  saveCache(cache);
  console.log(`Cache saved to ${CACHE_PATH}`);
  printCoverage(cache, allItems);
}

main().catch((err) => {
  console.error('Fatal build error:', err);
  process.exit(1);
});
