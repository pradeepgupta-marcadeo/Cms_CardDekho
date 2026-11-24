# Wheelora CMS

Content management for the Wheelora car website (`../website`). Node.js, Express 5 and PostgreSQL. Every page of the website reads its content from this CMS. When an editor saves, the website refreshes within a few seconds.

## Run it

```bash
npm install
cp .env.example .env        # then fill in the database password, admin login and AI keys
npm run setup               # creates the database and tables, seeds the current content and the admin
npm run dev                 # http://localhost:4000/admin
```

Then start the website in `../website` (`npm run build && npx next start -p 3001`). The website's `.env.local` needs `CMS_API_URL=http://localhost:4000` and the same `REVALIDATE_SECRET`.

`npm run check` runs ESLint (zero warnings allowed) and the unit tests.

## How the website gets its content

1. The CMS builds one JSON snapshot of everything published (`src/lib/snapshot.js`, served at `/api/public/snapshot`).
2. The website loads it through a cached function tagged `cms` (`website/src/data/store.ts`). Pages stay statically prerendered, so they load fast.
3. After every save, the CMS calls `POST {SITE_URL}/api/revalidate`. The tag expires, and the next visit renders with the new content.
4. Before every build, `website/scripts/pull-snapshot.mjs` saves the snapshot to `website/src/data/snapshot.json`. If the CMS is down, the website keeps working from that copy.

## Where the data comes from

Since 2026-11-16 **all car data comes from CarScrapper** (see below): brands, models, prices, variants, specifications, features, colours and photos are read from public CarDekho pages by `../cardekho/scrape.py`. CarDekho's terms do not allow this, and its photos belong to CarDekho or the car makers; the owner chose to use it anyway. Each car's `source` and each photo's credit say "CarDekho".

| Data | Source | How |
|---|---|---|
| Cars, variants, specs, features, colours, photos | CarDekho (via CarScrapper) | CarScrapper buttons and schedule |
| Guides, pros, cons, FAQs that CarDekho does not give | AI writer | Car → Write with AI |
| News leads | RSS feeds of Indian auto sites, and GDELT | Every 3 hours; AI writes an original draft from a lead |
| Owner reviews | The website's review form | Editors approve them under Owner reviews |

Switched off on 2026-11-16 (code kept, screens redirect to CarScrapper): the Scraper section (`../automotive-scraper`), VariantWise, PPAC fuel prices, OpenStreetMap / Open Charge Map stations and dealers, the Wikimedia photo finder and the daily car collector. Their data was removed by `src/scripts/carscraper-reset.js` (backup: `../backups/cms-before-carscraper-*.dump`, restore with `pg_restore`). Fuel price, station and dealer pages stay empty until filled by hand under Home → Places & prices.

## AI writing

`src/lib/ai.js` tries Gemini, then OpenAI, then Claude, skipping any provider without a key. `src/lib/ai-writer.js` holds the prompts. They allow only the facts given, ask for keywords used naturally, and keep titles and descriptions inside the guardrail ranges. Each draft is checked by `src/lib/seo-check.js`, and redone once if it misses. Drafts are never published automatically.

## Folders

- `src/routes`: admin screens (`admin.js` mounts them) and the public API (`public.js`)
- `src/lib`: snapshot, AI, SEO checker, keywords, redirects, auth
- `src/importers`: VariantWise, PPAC, OpenStreetMap, Open Charge Map, Wikimedia Commons, news
- `src/jobs/scheduler.js`: background schedule
- `src/views`: EJS templates; `src/public`: CSS and browser script
- `src/migrations`: SQL, applied in order by `npm run migrate`

## Scraper section (switched off)

The old **Scraper** sidebar group (the `../automotive-scraper` service, review and import of its records) is no longer shown; `/admin/scraper` and `/admin/imports` redirect to CarScrapper. The code is still in `src/routes/scraper.js`, `src/routes/imports.js` and `src/lib/scraper-*.js`.

## CarScrapper section

The sidebar item **CarScrapper** runs the Python scraper in `../cardekho/scrape.py` and feeds the website. Every button runs the whole chain: scrape → CMS database (`cardekho_*` tables) → new photos into the Media library → website catalogue (`brands`, `cars`, `variants`, `photos`). It also holds "All cars", "Brands" and "Photo library".

| Screen | What it does |
|---|---|
| Run scraper | One button per job: launched cars, latest launches, upcoming cars, variants of each, or everything. Options: Refresh (fetch saved ones again to catch price and spec changes), brand, max, photos. Live log, progress, and counts of NEW / UPDATED (old -> new) / SAME, plus Stop |
| Schedule | Daily, weekly or every few hours (IST). A start missed while another scrape runs happens once it is free. Run now, pause, delete |
| Update website | Writes every saved car into the website catalogue again (code: `src/lib/catalogue-sync.js`). Facts, variants and CarDekho photos are replaced; guides, pros, cons, FAQs, angle and keywords written by an editor or the AI are kept. Unchanged cars are skipped. A car shows on the website once it has a photo and a colour |
| Car pages: AI copy | `scrape.py --reviews` reads each model page (CarDekho's expert review: pros, cons, verdict, rated sections) as research only; then the AI writes every car page in our own words with its keywords (code: `src/lib/car-copy.js`): summary, verdict, angle, pros, cons, buying guide and FAQs. Checked before saving: under 2.5% of 8-word runs may match the research, and the text may not repeat another car's page; otherwise it is written again, then from the car's data alone. Unchanged cars are skipped (Refresh writes all again). Car scrapes end by writing the copy of new cars. CarDekho's review text is never shown on the website |
| Full photo gallery | Reads every car's full gallery (exterior and interior, often 100-170 photos; road-test shots left out) with a title from each file name, copies new photos in HD and puts them on the website: the images page has All / Exterior / Interior / Colours tabs and a full-screen viewer, and with a full-screen viewer |
| 360 view (CarWale / CarDekho) | `scrape.py --threesixty` finds each car's studio 360: CarWale first, else CarDekho's own "Feel the car" spin (`/<brand>-<model>-360-view.htm`, Object2VR config `360 View_out.xml`, frames `images/img_0_0_<n>.jpg`, about 36 on white, no watermark). CarWale's (`/<brand>-cars/<model>/360-view/`; the frame list comes from CarWale's player config, usually 72 frames, one every 5 degrees; open doors too where offered). The frames are copied, with CarWale's watermark as CarWale shows them, into `uploads/carwale360/` (code: `src/lib/spin-import.js`, table `car_spins`) and the website shows a turntable 360: drag to turn with a glide, turns by itself until touched, arrows and keys, zoom (wheel, pinch, buttons), full screen. A car without a CarWale 360 and without a 3D model has no 360 button. CarWale is credited on the image credits page. The frames are CarWale's photography: the owner decided to use them |
| Saved cars | What is saved in the CMS database: search, filter by type and brand; each car shows its photos, variants (with per-variant specs, features and on-road price), model specs, features and review text |
| Data & quality | Record counts per file, missing-field report, CSV / JSONL downloads |

- Every scrape button ends by saving its file into the CMS database: tables `cardekho_cars`, `cardekho_variants`, `cardekho_photos` (migration `008_cardekho_data.sql`). A record is updated only when its data changed; the log lists NEW and UPDATED (old → new). A launched car is never turned back into an upcoming one.
- Car scrapes (Launched, Latest, Upcoming, Everything) then copy the new pictures into the Media library by themselves; variant scrapes have no pictures. **Save to CMS database** saves the existing files without scraping. **Import photos** (only photos, for a retry) copies the pictures into the Media library as WebP under `uploads/cardekho/<brand>/`, with credit "CarDekho" and a copyright note; copied photos are skipped next time, failed ones are retried. The photos are CarDekho's / the manufacturers': check the rights before using any on the website.

- One job at a time, each in its own background process (`src/scripts/carscraper-worker.js`), so a job keeps running when the CMS restarts (code change under `npm run dev`, crash, deploy). The CMS reads the job from `import_runs` (kind `carscraper:<job>`); Stop is sent through the `carscraper_stop` setting. A job whose worker process is gone is marked failed; run it again and it continues. The full log of each run is in `../cardekho/cardekho_data/logs/run-<id>.log`.
- Starting, stopping and schedule changes need an admin and are written to the Activity log.
- Schedules run only when `SCHEDULER_ENABLED=true`.
- Needs Python 3 with `requests`. Set `CARSCRAPER_PYTHON` and `CARSCRAPER_SCRIPT` in `.env` if they are not the defaults.
- Code: `src/lib/carscraper.js` (runner, schedule timer, data files), `src/lib/carscraper-schedule.js` (schedule maths), `src/routes/carscraper.js`, views `carscraper*.ejs`.

### City, Brand and Max boxes (CarScrapper)

- **City** (On-road prices by city, Fuel prices): type any city, any way ("chandigarh", "BENGALURU", "gurugram", small typos; several with commas). scrape.py finds it in CarDekho's city list (`city_catalog.json`, about 1,650 cities with id and state, refreshed weekly); a city the website does not have yet is added to Cities by itself (name, slug, state). Empty = every city of the website. Not found = the log suggests close names.
- **Brand**: any spelling ("TATA", "Maruti Suzuki", "merc", "huyndai") is matched to a saved brand (`src/lib/name-match.js`); no match = an error with suggestions.
- **Max**: how much to fetch (cars, variants, pages or new cities, depending on the job).
- Fuel prices for a city not on CarDekho's main fuel page come from that city's own fuel pages, then its state's rate, then PPAC.
- The snapshot cache checks the content version in the database, so changes saved by a job's worker process reach the website without a CMS restart.
