# Marvel Addon for Stremio

A self-hosted continuation of [joaogonp/addon-marvel](https://github.com/joaogonp/addon-marvel), rebuilt to run on Node/Render after the original Deno Deploy host went offline.

**Live addon:** https://addon-marvel-a6rd.onrender.com

**Configure page:** https://addon-marvel-a6rd.onrender.com/configure

**Manifest:** https://addon-marvel-a6rd.onrender.com/manifest.json

**Stremio install:** `stremio://addon-marvel-a6rd.onrender.com/manifest.json`

---

## Features

- **8 catalogs** — MCU Chronologically Ordered, MCU Release Order, X-Men, Movies, Series, Animations, New Releases and Coming Soon.
- **Real metadata** — descriptions, posters, logos, genres, IMDb ratings and YouTube trailers for every cached title (TMDB + OMDb).
- **Search, genre filters and paging** on every catalog.
- **RatingPosterDB support** — optional RPDB key on the configure page.
- **Configurable install links** — pick only the catalogs you want.
- **Auto-updater** — GitHub Actions discovers new Marvel releases, refreshes metadata, guards against degraded data, and bumps the manifest version twice a week (Mondays + Thursdays).
- **Health endpoint** — `/health` reports uptime, version and the last data refresh.
- **Sensible cache policy** — catalog payloads cached for an hour; manifests and pages always revalidate.

---

## Catalogs

| ID | Name |
| --- | --- |
| `marvel-mcu` | MCU Chronologically Ordered |
| `release-order` | MCU Release Order |
| `xmen` | X-Men |
| `movies` | Movies |
| `series` | Series |
| `animations` | Animations |
| `marvel-new` | New Releases (added in the last 120 days) |
| `marvel-upcoming` | Coming Soon (confirmed future release dates) |

The MCU chronological and release-order lists are curated. The updater adds new titles to Movies / Series / Animations and surfaces them in New Releases; hand-placed MCU ordering stays manual.

---

## Install / self-host

### Render (recommended)

1. Open the Blueprint deploy link: **https://render.com/deploy?repo=https://github.com/skypetroller/addon-marvel**
2. Select the repo and create the web service (the live service is `addon-marvel-a6rd`).
3. Add the environment variables:
   - `TMDB_API_KEY` — TMDB API key (v3)
   - `OMDB_API_KEY` — OMDb API key (free tier is fine)
4. Deploy. The service starts with `npm start` and exposes `/health`.

Render's free tier spins a service down after ~15 minutes without traffic. The addon still works, but the first request after a nap can take 30–60 seconds. Keeping this service awake 24/7 would consume most of Render's 750 shared free instance-hours (the DC addon already uses that budget), so no keep-alive is configured by default.

### Local development

```bash
npm install
cp .env.example .env   # add your TMDB/OMDb keys
npm start
# http://localhost:7000/configure
```

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `TMDB_API_KEY` | yes | Metadata, posters, logos, trailers, release dates |
| `OMDB_API_KEY` | recommended | Real IMDb ratings and fallback plots |
| `PORT` | no | Defaults to `7000` |

---

## API

| Endpoint | Description |
| --- | --- |
| `/manifest.json` | Default manifest (all catalogs) |
| `/rpdb/<key>/manifest.json` | Manifest with RPDB posters |
| `/catalog/<id1,id2>/manifest.json` | Manifest with selected catalogs |
| `/catalog/<type>/<id>.json` | Catalog data |
| `/catalog/<type>/<id>/search=<q>&genre=<g>&skip=<n>.json` | Search / genre / paging |
| `/api/catalogs` | Catalog list with live counts |
| `/health` | Status, uptime, version, last data refresh |

---

## Data updater

The workflow lives in `.github/workflows/update-data.yml` and runs Mondays and Thursdays at 06:17 UTC (or manually from the Actions tab).

It runs, in order:

1. `scripts/discoverNewReleases.js` — TMDB discover for Marvel production companies; adds genuinely new titles.
2. `scripts/buildMetadata.js --refresh` — refreshes the on-disk metadata cache.
3. `scripts/guardDataQuality.js` — refuses to commit if catalog counts or metadata coverage collapse.
4. `scripts/writeLastUpdated.js` — stamps `Data/lastUpdated.json`.
5. `scripts/bumpVersion.js` — bumps the manifest/package patch version when content changed.

Repository secrets required: `TMDB_API_KEY`, `OMDB_API_KEY`.

To run the updater locally:

```bash
npm run discover
npm run build-metadata:refresh
npm run guard
npm run stamp
```

---

## Credits

Original project and catalog data: [joaogonp/addon-marvel](https://github.com/joaogonp/addon-marvel) (MIT). This fork preserves the upstream history and rewrites the runtime for Node/Render.

## License

MIT — see [LICENSE](LICENSE).
