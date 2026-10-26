#!/usr/bin/env node
/**
 * CI guard: refuses to commit a refresh that degraded the catalog.
 *
 * Checks:
 *   - no catalog file loses items vs HEAD
 *   - metadata cache does not lose entries or collapse in coverage
 *   - every catalog item still has a cache entry
 *   - required fields are present
 *
 * Run by the updater after discovery + metadata refresh.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import moviesData from '../Data/moviesData.js';
import seriesData from '../Data/seriesData.js';
import animationsData from '../Data/animationsData.js';
import chronologicalData from '../Data/chronologicalData.js';
import releaseData from '../Data/releaseData.js';
import xmenData from '../Data/xmenData.js';
import { lookupIdFor } from '../lib/metadata.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const DATA_FILES = [
  'Data/moviesData.js',
  'Data/seriesData.js',
  'Data/animationsData.js',
  'Data/chronologicalData.js',
  'Data/releaseData.js',
  'Data/xmenData.js',
];

const CURRENT_DATA = {
  'Data/moviesData.js': moviesData,
  'Data/seriesData.js': seriesData,
  'Data/animationsData.js': animationsData,
  'Data/chronologicalData.js': chronologicalData,
  'Data/releaseData.js': releaseData,
  'Data/xmenData.js': xmenData,
};

function loadFromGit(relPath) {
  const src = execSync(`git show HEAD:${relPath}`, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  const json = src.replace(/^export default\s+/, '').replace(/;\s*$/, '');
  return JSON.parse(json);
}

function loadCache(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function cacheStats(cache) {
  const values = Object.values(cache);
  return {
    count: values.length,
    withDescription: values.filter(
      (entry) => entry.description && entry.description !== 'No description available.'
    ).length,
    withRating: values.filter(
      (entry) => entry.imdbRating && entry.imdbRating !== 'N/A'
    ).length,
    withTmdbId: values.filter((entry) => entry.tmdbId).length,
    withLogo: values.filter((entry) => entry.logo).length,
    withTrailer: values.filter((entry) => entry.trailer).length,
    withPoster: values.filter((entry) => entry.poster).length,
  };
}

function collapsed(before, after) {
  return before > 0 && after < before * 0.5;
}

function uniqueCount(items) {
  return new Set(items.map((item) => lookupIdFor(item)).filter(Boolean)).size;
}

let failed = false;

// --- Catalog files ---------------------------------------------------------
for (const file of DATA_FILES) {
  const current = CURRENT_DATA[file];
  let before;
  try {
    before = loadFromGit(file);
  } catch (err) {
    console.log(`SKIP ${file}: not in HEAD (new file)`);
    continue;
  }

  const beforeCount = uniqueCount(before);
  const currentCount = uniqueCount(current);
  if (currentCount < beforeCount) {
    console.error(`FAIL ${file}: unique item count dropped ${beforeCount} -> ${currentCount}`);
    failed = true;
  } else {
    console.log(`OK   ${file}: ${currentCount} unique items (was ${beforeCount})`);
  }

  const seen = new Set();
  for (const item of current) {
    const lookupId = lookupIdFor(item);
    if (!lookupId) {
      console.error(`FAIL ${file}: item without an IMDb/TMDB id: ${JSON.stringify(item).slice(0, 120)}`);
      failed = true;
    }
    if (!item.title || !item.type) {
      console.error(`FAIL ${file}: item missing title/type: ${JSON.stringify(item).slice(0, 120)}`);
      failed = true;
    }
    if (seen.has(lookupId)) {
      console.warn(`WARN ${file}: duplicate id ${lookupId}`);
    }
    seen.add(lookupId);
  }
}

// --- Metadata cache --------------------------------------------------------
const cachePath = path.join(ROOT, 'Data', 'metadataCache.json');
const cache = loadCache(cachePath);
const currentStats = cacheStats(cache);

let previousCache = null;
try {
  previousCache = JSON.parse(
    execSync('git show HEAD:Data/metadataCache.json', {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    })
  );
} catch (err) {
  console.log('SKIP metadata cache comparison: no HEAD version');
}

if (previousCache) {
  const beforeStats = cacheStats(previousCache);
  console.log(
    `Cache: ${beforeStats.count} -> ${currentStats.count} entries, ` +
      `descriptions ${beforeStats.withDescription} -> ${currentStats.withDescription}, ` +
      `ratings ${beforeStats.withRating} -> ${currentStats.withRating}, ` +
      `TMDB ids ${beforeStats.withTmdbId} -> ${currentStats.withTmdbId}, ` +
      `trailers ${beforeStats.withTrailer} -> ${currentStats.withTrailer}`
  );

  if (currentStats.count < beforeStats.count) {
    console.error(`FAIL cache: entry count dropped ${beforeStats.count} -> ${currentStats.count}`);
    failed = true;
  }
  for (const field of [
    'withDescription',
    'withRating',
    'withTmdbId',
    'withLogo',
    'withTrailer',
    'withPoster',
  ]) {
    if (collapsed(beforeStats[field], currentStats[field])) {
      console.error(
        `FAIL cache: ${field} collapsed ${beforeStats[field]} -> ${currentStats[field]}`
      );
      failed = true;
    }
  }
} else {
  console.log(`Cache: ${currentStats.count} entries`);
}

// Every catalog item must have a cache entry. Allow a tiny margin for a
// just-announced title whose IMDb/TMDB data is not available yet.
const allItems = Object.values(CURRENT_DATA).flat();
const uniqueItems = new Map();
for (const item of allItems) {
  const lookupId = lookupIdFor(item);
  if (lookupId) uniqueItems.set(lookupId, item);
}
const missing = [...uniqueItems.keys()].filter((lookupId) => !cache[lookupId]);
const missingLimit = Math.max(3, Math.ceil(uniqueItems.size * 0.02));
if (missing.length > missingLimit) {
  console.error(
    `FAIL cache: ${missing.length}/${uniqueItems.size} catalog items are missing ` +
      `(limit ${missingLimit}): ${missing.slice(0, 10).join(', ')}`
  );
  failed = true;
} else {
  console.log(
    `Cache coverage: ${uniqueItems.size - missing.length}/${uniqueItems.size} catalog items` +
      (missing.length ? ` (${missing.length} pending)` : '')
  );
}

for (const [id, entry] of Object.entries(cache)) {
  if (!entry || entry.id !== id) {
    console.warn(`WARN cache: key/id mismatch for ${id}`);
  }
}

if (failed) {
  console.error('\nData quality guard FAILED — refusing to commit degraded data.');
  process.exit(1);
}

console.log('\nData quality guard passed.');
