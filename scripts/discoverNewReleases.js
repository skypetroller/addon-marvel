#!/usr/bin/env node
/**
 * Discovers new Marvel releases via TMDB and appends them to the catalog files.
 *
 * Additive only: existing entries are never modified or removed. New titles land
 * in Movies / Series / Animations and are surfaced by the "New Releases" catalog.
 * The hand-curated MCU chronological/release-order catalogs stay manual.
 *
 * Run weekly by .github/workflows/update-data.yml.
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';

import moviesData from '../Data/moviesData.js';
import seriesData from '../Data/seriesData.js';
import animationsData from '../Data/animationsData.js';
import chronologicalData from '../Data/chronologicalData.js';
import releaseData from '../Data/releaseData.js';
import xmenData from '../Data/xmenData.js';
import { fetchTmdbDetails, lookupIdFor } from '../lib/metadata.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMDB_API_KEY = process.env.TMDB_API_KEY;

if (!TMDB_API_KEY) {
  console.error('CRITICAL: TMDB_API_KEY is not set.');
  process.exit(1);
}

// Marvel Studios, Marvel Entertainment, Marvel Television, Marvel Animation,
// Marvel Knights, Marvel Films and Marvel Productions.
const MARVEL_COMPANY_IDS = [420, 7505, 38679, 13252, 11106, 108634, 2301];
const COMPANY_QUERY = MARVEL_COMPANY_IDS.join('|');
const ANIMATION_GENRE_ID = 16;
const TALK_SHOW_GENRE_ID = 10767;

const cutoff = new Date();
cutoff.setFullYear(cutoff.getFullYear() - 2);
const CUTOFF = cutoff.toISOString().slice(0, 10);

const FILES = {
  movies: path.join(__dirname, '../Data/moviesData.js'),
  series: path.join(__dirname, '../Data/seriesData.js'),
  animations: path.join(__dirname, '../Data/animationsData.js'),
};

function writeDataFile(file, data) {
  fs.writeFileSync(file, `export default ${JSON.stringify(data, null, 2)};\n`);
}

async function discover(media) {
  const isMovie = media === 'movie';
  const dateParam = isMovie ? 'primary_release_date.gte' : 'first_air_date.gte';
  const sort = isMovie ? 'primary_release_date.desc' : 'first_air_date.desc';
  const results = [];
  let page = 1;
  let totalPages = 1;

  do {
    const url =
      `https://api.themoviedb.org/3/discover/${media}` +
      `?api_key=${TMDB_API_KEY}&language=en-US&include_adult=false` +
      `&with_companies=${COMPANY_QUERY}&${dateParam}=${CUTOFF}` +
      `&sort_by=${sort}&page=${page}`;
    try {
      const res = await axios.get(url, { timeout: 20000 });
      results.push(...(res.data.results || []));
      totalPages = Math.min(res.data.total_pages || 1, 10);
    } catch (err) {
      console.warn(`discover/${media} page ${page} failed: ${err.message}`);
      break;
    }
    page += 1;
  } while (page <= totalPages);

  console.log(`discover/${media}: ${results.length} candidates since ${CUTOFF}`);
  return results;
}

function sortByYear(a, b) {
  const yearA = parseInt(a.releaseYear, 10) || 9999;
  const yearB = parseInt(b.releaseYear, 10) || 9999;
  return yearA - yearB || String(a.title).localeCompare(String(b.title));
}

async function main() {
  console.log('Discovering new Marvel releases...');

  const cachePath = path.join(__dirname, '../Data/metadataCache.json');
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  } catch (err) {
    console.warn('No metadata cache found; known-title matching will use catalog files only.');
  }

  const allData = [
    ...chronologicalData,
    ...releaseData,
    ...xmenData,
    ...moviesData,
    ...seriesData,
    ...animationsData,
  ];

  const knownTmdbIds = new Set();
  const knownImdbIds = new Set();
  for (const item of allData) {
    if (item.tmdbId) knownTmdbIds.add(Number(item.tmdbId));
    const lookupId = lookupIdFor(item);
    if (/^tt\d+$/.test(lookupId)) knownImdbIds.add(lookupId);
  }
  for (const [id, entry] of Object.entries(cache)) {
    if (entry.tmdbId) knownTmdbIds.add(Number(entry.tmdbId));
    if (/^tt\d+$/.test(id)) knownImdbIds.add(id);
  }

  const [movieResults, tvResults] = await Promise.all([discover('movie'), discover('tv')]);
  const added = { movies: 0, series: 0, animations: 0 };
  const addedEntries = [];

  for (const [media, results] of [
    ['movie', movieResults],
    ['tv', tvResults],
  ]) {
    for (const result of results) {
      if (knownTmdbIds.has(Number(result.id))) continue;

      const details = await fetchTmdbDetails(media, result.id, TMDB_API_KEY);
      if (!details) continue;

      const title = String(details.title || details.name || '').trim();
      const releaseDate = details.release_date || details.first_air_date || null;
      const releaseYear = releaseDate ? releaseDate.slice(0, 4) : 'TBD';
      const genres = details.genres || [];
      const companies = details.production_companies || [];
      const imdbId = details.external_ids?.imdb_id || null;

      if (!title) continue;
      if (knownImdbIds.has(imdbId)) continue;
      if (!companies.some((company) => company && MARVEL_COMPANY_IDS.includes(company.id))) {
        continue;
      }
      if (/untitled/i.test(title)) {
        console.log(`  skip "${title}" — placeholder title`);
        continue;
      }
      if (genres.some((genre) => genre && genre.id === TALK_SHOW_GENRE_ID)) {
        console.log(`  skip "${title}" — talk/podcast content`);
        continue;
      }
      if (genres.some((genre) => genre && genre.id === 99)) {
        console.log(`  skip "${title}" — documentary/companion content`);
        continue;
      }
      if (/podcast|marvel studios assembled|making of/i.test(title)) {
        console.log(`  skip "${title}" — companion content`);
        continue;
      }
      if (media === 'movie' && details.runtime && details.runtime < 45) {
        console.log(`  skip "${title}" — short (${details.runtime} min)`);
        continue;
      }
      const episodeRuntime = (details.episode_run_time || []).find((value) => value > 0) || 0;
      if (media === 'tv' && episodeRuntime && episodeRuntime < 11) {
        console.log(`  skip "${title}" — shorts series (${episodeRuntime} min episodes)`);
        continue;
      }
      if (!details.poster_path || !details.overview || !details.overview.trim()) {
        console.log(`  skip "${title}" — no poster/overview yet (retry next run)`);
        continue;
      }
      if (!imdbId) {
        console.log(`  skip "${title}" — no IMDb ID yet (retry next run)`);
        continue;
      }

      const isAnimated = genres.some((genre) => genre && genre.id === ANIMATION_GENRE_ID);
      const entry = {
        tmdbId: result.id,
        title,
        type: media === 'tv' ? 'series' : 'movie',
        imdbId,
        id: `marvel_${imdbId}`,
        releaseYear,
        releaseDate,
        poster: `https://image.tmdb.org/t/p/w500${details.poster_path}`,
        overview: details.overview,
        genres,
        addedAt: new Date().toISOString().slice(0, 10),
        discovered: true,
      };

      if (isAnimated) {
        animationsData.push(entry);
        added.animations += 1;
      } else if (media === 'movie') {
        moviesData.push(entry);
        added.movies += 1;
      } else {
        seriesData.push(entry);
        added.series += 1;
      }

      knownTmdbIds.add(Number(result.id));
      knownImdbIds.add(imdbId);
      addedEntries.push({
        title,
        year: releaseYear,
        type: isAnimated ? 'animation' : media === 'tv' ? 'series' : 'movie',
      });
      console.log(`  + ${isAnimated ? 'animated' : media === 'tv' ? 'series' : 'movie'}: "${title}" (${releaseYear})`);
    }
  }

  moviesData.sort(sortByYear);
  seriesData.sort(sortByYear);
  animationsData.sort(sortByYear);

  writeDataFile(FILES.movies, moviesData);
  writeDataFile(FILES.series, seriesData);
  writeDataFile(FILES.animations, animationsData);

  fs.writeFileSync(
    path.join(__dirname, '../discovery-report.json'),
    `${JSON.stringify(
      { generatedAt: new Date().toISOString(), items: addedEntries },
      null,
      2
    )}\n`
  );

  console.log(
    `Discovery complete: +${added.movies} movies, +${added.series} series, +${added.animations} animations`
  );
}

main().catch((err) => {
  console.error('Discovery failed:', err);
  process.exit(1);
});
