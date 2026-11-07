# Marvel Add-on for Stremio

A self-hosted fork of [joaogonp/addon-marvel](https://github.com/joaogonp/addon-marvel), rebuilt to run on Node/Render after the original Deno Deploy host went offline. It keeps itself up to date automatically: GitHub Actions discovers new Marvel releases, refreshes metadata, and commits the changes twice a week.

**Live addon:** https://addon-marvel-a6rd.onrender.com
**Configure page:** https://addon-marvel-a6rd.onrender.com/configure
**Manifest:** https://addon-marvel-a6rd.onrender.com/manifest.json
**Stremio install:** `stremio://addon-marvel-a6rd.onrender.com/manifest.json`

---

## Features

- **Automatic updates** — GitHub Actions discovers new Marvel releases, refreshes metadata, guards against degraded data, and bumps the manifest version twice a week (Mondays and Thursdays).
- **Curated MCU orders** — chronological and release-order rows for movies and series, alongside the broader Marvel library.
- **Coming Soon** — announced titles with a confirmed future release date.
- **New Releases** — everything added to the library in the last 120 days, split into movie and series rows.
- **Search, genre filters and paging** — every catalog ships a search box, a genre dropdown and infinite scrolling.
- **Trailers** — YouTube trailer links are stored with the data and surfaced by Stremio.
- **RPDB support (optional)** — show ratings on posters by adding your [RatingPosterDB](https://ratingposterdb.com) API key on the configure page.
- **Data quality guard** — CI refuses to commit degraded data (counting drops, missing posters, overviews or ratings after a quota hiccup), and failures open a GitHub issue automatically.
- **Freshness visible** — the configure page footer shows the last data refresh, `/health` reports it as JSON, and a shared keep-awake workflow keeps both Marvel and DC warm during a 12-hour daily window.
- **Sensible cache policy** — catalog payloads are cached for one hour; manifests and pages always revalidate.

---

## Catalogs

| Catalog | ID | Contents |
| --- | --- | --- |
| Coming Soon | `marvel-upcoming` | Announced titles with a confirmed future release date |
| New Releases (Movies) | `marvel-new-movies` | Marvel movies added in the last 120 days |
| New Releases (Series) | `marvel-new-series` | Marvel series added in the last 120 days |
| MCU Chronologically Ordered (Movies) | `marvel-mcu-movies` | MCU films in story order |
| MCU Chronologically Ordered (Series) | `marvel-mcu-series` | MCU shows in story order |
| MCU Release Order (Movies) | `release-order-movies` | MCU films by release date |
| MCU Release Order (Series) | `release-order-series` | MCU shows by release date |
| X-Men | `xmen` | X-Men and mutant titles |
| Movies | `movies` | All live-action Marvel movies |
| Series | `series` | All live-action Marvel series |
| Animations (Movies) | `animations-movies` | Animated Marvel features |
| Animations (Series) | `animations-series` | Animated Marvel series |

Lists that contain both movies and series are exposed as `-movies` and `-series` catalog variants. Stremio only renders the standard `movie` and `series` types reliably, so this keeps every row visible on the Board, Discover and Android TV. Old custom install links that use a base ID (for example `marvel-mcu`) still work and expand to both variants.

The MCU chronological and release-order lists are curated. The updater adds new titles to Movies / Series / Animations and surfaces them in New Releases; hand-placed MCU ordering stays manual.

---

## Installation

### Standard installation

Use the addon URL directly:

```
https://addon-marvel-a6rd.onrender.com/manifest.json
```

This is the canonical install URL. Stremio pins each addon record to the exact URL it was installed from, so use this URL for new installs.

### Custom catalog configuration

1. Visit the configuration page: https://addon-marvel-a6rd.onrender.com/configure
2. Select the catalogs you want (optionally add your RPDB key).
3. Click **Install addon**.

The install URL encodes your selection, e.g. `https://addon-marvel-a6rd.onrender.com/catalog/marvel-upcoming,movies/manifest.json`.

---

## Deploy your own

1. **Fork** this repository.
2. **Get API keys** (both free): [TMDb](https://www.themoviedb.org/settings/api) and [OMDb](https://www.omdbapi.com/apikey.aspx).
3. **Add GitHub secrets** (Settings → Secrets and variables → Actions): `TMDB_API_KEY`, `OMDB_API_KEY`.
4. **Deploy on Render** as a Web Service — build command `npm ci`, start command `npm start` — and set the same two environment variables (`PORT` is provided by Render).
5. Optional: update the URLs inside `.github/workflows/keepalive.yml` and the badge links if you rename the service.

### Keep-awake window

Render's free tier spins a service down after ~15 minutes without traffic and gives each workspace 750 instance-hours per month. Keeping both this addon and the DC addon awake 24/7 would need ~1,460 hours, so the shared `.github/workflows/keepalive.yml` keeps both warm during a roughly 12-hour daily window: **~10:00–21:45 UTC**. Pings run from 09:55 to 21:30, then Render's idle timer covers the remaining 15 minutes. Outside that window the first request can take 30–60 seconds to cold-start.

The same workflow is intentionally present in both the Marvel and DC repositories; either repository can keep both services warm if GitHub throttles the other. It uses long-lived jobs because GitHub throttles short `*/10` cron workflows.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `TMDB_API_KEY` | yes | Metadata, posters, logos, trailers and release dates |
| `OMDB_API_KEY` | recommended | IMDb ratings and fallback plots |
| `PORT` | no | Defaults to `7000` |

---

## Running locally

```bash
git clone https://github.com/skypetroller-addons/addon-marvel.git
cd addon-marvel
npm ci
```

Create a `.env` file:

```
TMDB_API_KEY=your_tmdb_key
OMDB_API_KEY=your_omdb_key
PORT=7000
```

Start the server:

```bash
npm start
```

Then open `http://localhost:7000/configure`.

To refresh the data manually:

```bash
npm run discover
npm run build-metadata:refresh
npm run guard
npm run stamp
```

---

## How the automatic updates work

`.github/workflows/update-data.yml` runs every **Monday and Thursday at 06:17 UTC** (and on demand from the Actions tab):

1. Discovers new Marvel releases from TMDb and appends genuinely new titles.
2. Refreshes the on-disk metadata cache (posters, overviews, ratings, release dates).
3. Runs the data-quality guard.
4. Stamps `Data/lastUpdated.json`.
5. Commits the updated data and bumps the manifest version when content changed.
6. Render redeploys automatically; catalogs are cached for one hour.

The commit message lists the new titles. Successful runs close any open "Data updater failed" issue; failures open one.

---

## API routes

| Route | Purpose |
| --- | --- |
| `/manifest.json` | Full addon manifest (all catalogs); canonical install URL |
| `/catalog/<ids>/manifest.json` | Manifest limited to selected catalogs |
| `/catalog/<type>/<id>.json` | Catalog data (also accepts `/search=x&genre=y&skip=100` extras) |
| `/rpdb/<key>/manifest.json` | Manifest with RPDB posters |
| `/configure` | Configuration page |
| `/api/catalogs` | Catalog list with live item counts |
| `/health` | Status, uptime, version and last data refresh |

---

## License

MIT — see [LICENSE](LICENSE).

---

## Acknowledgements

- **joaogonp** — creator of the original Marvel addon this project descends from.
- This fork adds the Node/Render runtime, automated updates, the data-quality guard, freshness reporting and the split movie/series catalog variants.
