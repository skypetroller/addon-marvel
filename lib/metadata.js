// Shared metadata helpers used by both the live server and the build scripts.
// Keeping the TMDB/OMDb logic in one place means the pre-built cache and the
// on-demand fallback produce identical Stremio metas.

import axios from 'axios';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';
const FALLBACK_POSTER =
  'https://m.media-amazon.com/images/M/MV5BMTczNTI2ODUwOF5BMl5BanBnXkFtZTcwMTU0NTIzMw@@._V1_SX300.jpg';

const REQUEST_TIMEOUT = 20000;

export function normalizeType(type) {
  return type === 'series' || type === 'tv' ? 'series' : 'movie';
}

export function lookupIdFor(item) {
  const raw = String(item?.imdbId || item?.id || '').trim();
  if (raw.startsWith('marvel_')) return raw.slice('marvel_'.length);
  return raw;
}

export function isValidUrl(value) {
  if (!value || value === 'N/A' || String(value).includes('undefined')) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export function isUsablePoster(value) {
  return isValidUrl(value) && !String(value).includes('web.archive.org');
}

export function pickPoster(item, tmdbData, omdbData, existing) {
  if (isUsablePoster(item?.poster)) return item.poster;
  if (tmdbData?.poster_path) return `${TMDB_IMAGE_BASE}/w500${tmdbData.poster_path}`;
  if (isUsablePoster(omdbData?.Poster)) return omdbData.Poster;
  if (isUsablePoster(existing?.poster)) return existing.poster;
  return FALLBACK_POSTER;
}

export function pickLogo(images) {
  const logos = (images?.logos || []).filter((logo) => logo && logo.file_path);
  const best =
    logos.find((logo) => logo.iso_639_1 === 'en') ||
    logos.find((logo) => logo.iso_639_1 === 'pt') ||
    logos[0];
  return best ? `${TMDB_IMAGE_BASE}/original${best.file_path}` : null;
}

export function pickTrailer(videos) {
  const candidates = (videos?.results || []).filter(
    (video) =>
      video &&
      video.site === 'YouTube' &&
      video.key &&
      (video.type === 'Trailer' || video.type === 'Teaser')
  );
  if (!candidates.length) return null;

  const score = (video) => {
    let value = video.type === 'Trailer' ? 0 : 10;
    if (video.iso_639_1 !== 'en') value += 2;
    if (!video.official) value += 1;
    return value;
  };

  return candidates.sort((a, b) => score(a) - score(b))[0].key;
}

function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^marvel'?s\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function titleMatches(result, wantedTitle, wantedYear) {
  const wanted = normalizeTitle(wantedTitle);
  const found = normalizeTitle(result.title || result.name || result.original_title || result.original_name);
  if (!wanted || !found) return true;
  if (wanted !== found && !wanted.includes(found) && !found.includes(wanted)) return false;

  if (wantedYear) {
    const foundYear = String(result.release_date || result.first_air_date || '').slice(0, 4);
    if (foundYear && Math.abs(Number(foundYear) - Number(wantedYear)) > 1) return false;
  }
  return true;
}

export async function findTmdb(item, tmdbKey) {
  if (!tmdbKey) return null;

  const preferred = normalizeType(item.type) === 'series' ? 'tv' : 'movie';
  if (item.tmdbId) return { media: preferred, id: Number(item.tmdbId) };

  const lookupId = lookupIdFor(item);

  if (/^tt\d+$/.test(lookupId)) {
    try {
      const { data } = await axios.get(`${TMDB_BASE}/find/${lookupId}`, {
        params: { api_key: tmdbKey, external_source: 'imdb_id' },
        timeout: REQUEST_TIMEOUT,
      });
      const movie = (data.movie_results || [])[0];
      const tv = (data.tv_results || [])[0];
      if (preferred === 'tv') {
        if (tv) return { media: 'tv', id: tv.id };
        if (movie) return { media: 'movie', id: movie.id };
      } else {
        if (movie) return { media: 'movie', id: movie.id };
        if (tv) return { media: 'tv', id: tv.id };
      }
    } catch (err) {
      // Fall through to title search.
    }
  }

  const title = String(item.title || '').replace(/ Season \d+$/i, '').trim();
  const year = item.releaseYear || '';
  if (!title) return null;

  const mediaOrder = preferred === 'tv' ? ['tv', 'movie'] : ['movie', 'tv'];
  for (const media of mediaOrder) {
    try {
      const params = { api_key: tmdbKey, query: title, language: 'en-US' };
      if (year) params[media === 'tv' ? 'first_air_date_year' : 'year'] = year;
      const { data } = await axios.get(`${TMDB_BASE}/search/${media}`, {
        params,
        timeout: REQUEST_TIMEOUT,
      });
      const results = data.results || [];
      const result = results.find((entry) => titleMatches(entry, title, year)) || results[0];
      if (result) return { media, id: result.id };
    } catch (err) {
      // Try the other media type.
    }
  }

  return null;
}

export async function fetchTmdbDetails(media, id, tmdbKey) {
  if (!tmdbKey || !id) return null;
  try {
    const { data } = await axios.get(`${TMDB_BASE}/${media}/${id}`, {
      params: {
        api_key: tmdbKey,
        language: 'en-US',
        append_to_response: 'external_ids,videos,images',
        include_image_language: 'en,null',
      },
      timeout: REQUEST_TIMEOUT,
    });
    return data || null;
  } catch (err) {
    return null;
  }
}

export async function fetchOmdb(imdbId, omdbKey) {
  if (!omdbKey || !/^tt\d+$/.test(imdbId)) return null;
  try {
    const { data } = await axios.get('https://www.omdbapi.com/', {
      params: { i: imdbId, apikey: omdbKey, plot: 'short' },
      timeout: 15000,
    });
    return data && data.Response !== 'False' ? data : null;
  } catch (err) {
    return null;
  }
}

function parseOmdbGenres(value) {
  if (!value || value === 'N/A') return [];
  return String(value)
    .split(',')
    .map((genre) => genre.trim())
    .filter(Boolean);
}

function normalizeGenres(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((genre) => (typeof genre === 'string' ? genre : genre?.name))
    .filter(Boolean);
}

export function buildMetadataEntry(item, { tmdbKey, omdbKey, existing = null } = {}) {
  const type = normalizeType(item.type);
  const lookupId = lookupIdFor(item);
  const imdbId = /^tt\d+$/.test(lookupId) ? lookupId : item.imdbId || '';

  return (async () => {
    const found = await findTmdb(item, tmdbKey);
    const [tmdbData, omdbData] = await Promise.all([
      found ? fetchTmdbDetails(found.media, found.id, tmdbKey) : Promise.resolve(null),
      fetchOmdb(imdbId, omdbKey),
    ]);

    const releaseDate =
      tmdbData?.release_date ||
      tmdbData?.first_air_date ||
      item.releaseDate ||
      existing?.releaseDate ||
      null;

    const releaseYear =
      item.releaseYear ||
      (releaseDate ? String(releaseDate).slice(0, 4) : '') ||
      String(omdbData?.Year || '').slice(0, 4) ||
      existing?.releaseInfo ||
      'N/A';

    const title =
      tmdbData?.title ||
      tmdbData?.name ||
      item.title ||
      existing?.name ||
      'Unknown';

    const description =
      item.description ||
      item.overview ||
      tmdbData?.overview ||
      omdbData?.Plot ||
      existing?.description ||
      'No description available.';

    const imdbRating =
      omdbData?.imdbRating && omdbData.imdbRating !== 'N/A'
        ? omdbData.imdbRating
        : tmdbData?.vote_average
          ? tmdbData.vote_average.toFixed(1)
          : existing?.imdbRating || 'N/A';

    const genres =
      normalizeGenres(tmdbData?.genres).length > 0
        ? normalizeGenres(tmdbData.genres)
        : parseOmdbGenres(omdbData?.Genre).length > 0
          ? parseOmdbGenres(omdbData.Genre)
          : normalizeGenres(item.genres).length > 0
            ? normalizeGenres(item.genres)
            : existing?.genres || [];

    return {
      id: lookupId || existing?.id || '',
      type,
      name: type === 'series' ? String(title).replace(/ Season \d+$/i, '') : String(title),
      logo: pickLogo(tmdbData?.images) || existing?.logo || null,
      poster: pickPoster(item, tmdbData, omdbData, existing),
      description,
      releaseInfo: String(releaseYear),
      releaseDate: releaseDate || null,
      imdbRating,
      genres,
      tmdbId: tmdbData?.id || found?.id || item.tmdbId || existing?.tmdbId || null,
      trailer: pickTrailer(tmdbData?.videos) || existing?.trailer || null,
      updatedAt: new Date().toISOString().slice(0, 10),
    };
  })();
}

export function meaningfulFields(entry) {
  if (!entry) return null;
  const fields = [
    'id',
    'type',
    'name',
    'logo',
    'poster',
    'description',
    'releaseInfo',
    'releaseDate',
    'imdbRating',
    'genres',
    'tmdbId',
    'trailer',
  ];
  return fields.map((field) => entry[field] ?? null);
}

export function sameMetadata(a, b) {
  return JSON.stringify(meaningfulFields(a)) === JSON.stringify(meaningfulFields(b));
}

export { FALLBACK_POSTER };
