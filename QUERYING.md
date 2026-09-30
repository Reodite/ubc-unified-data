# Querying this dataset

Where everything lives, what joins to what, and the encodings that will trip you
up. The [README](README.md) covers what each group _is_ and how it was gathered;
this covers how to get answers out of it.

Everything is plain files. There is no database, no API, no query layer — you
load JSON or CSV and filter it.

---

## Contents

- [Start here](#start-here)
- [The map](#the-map) — every table, where it is, how many rows
- [The join graph](#the-join-graph) — verified keys and their match rates
- [Encodings and traps](#encodings-and-traps)
- [Recipes](#recipes)
- [What this data cannot answer](#what-this-data-cannot-answer)

---

## Start here

Three files describe the dataset. Read them before guessing from filenames.

| File                 | What it gives you                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `data/catalog.json`  | **The index.** One entry per _table_, with `grain` (what one row is), `columns`, and `joins`.               |
| `data/manifest.json` | The same, per _file_: byte size, source URL, record count, run status, last refresh.                        |
| `data/*/​_*.json`    | Per-group provenance — `_sources.json`, `_source.json`, `_snapshot.json`, `_sites.json`, `_unmatched.json`. |

```js
import { readFile } from "node:fs/promises";

const catalog = JSON.parse(await readFile("data/catalog.json", "utf8"));

for (const [name, group] of Object.entries(catalog.groups)) {
  for (const t of group.tables) {
    if (t.grain) console.log(t.path, "->", t.grain);
  }
}
```

Run from the repo root with `node --input-type=module`. The undergraduate fact
tables carry `grain` and column descriptions; some other tables omit those fields.
Mirrored geospatial layers also ship `metadata/` CSVs defining their fields. Use the catalog for current counts and
[UNDERGRADUATE-SOURCES.md](UNDERGRADUATE-SOURCES.md) for source and coverage details.

Read `data/prose/_catalog.json` for article tables and `data/prose/_manifest.json`
for coverage metadata. Reogent loads the catalog beneath its normal `DATA_PATH`
for default ingestion into the same Meilisearch service as the other datasets.
`npm run collect:prose` refreshes the tracked exports. See [PROSE.md](PROSE.md).

### File conventions

- Every tabular dataset is written **twice**: `name.json` (nested values intact)
  and `name.csv` (same rows, nested values JSON-encoded into the cell).
- Files beginning with `_` are _about_ the data, not data.
- Geospatial keeps the upstream repo's layout (`ubcv/`, `off-campus/`) so paths
  match UBC's own documentation.
- **This dataset is UBC Vancouver only** by default. See the README's Campus
  section for how the filter applies per group.

---

## The map

### `data/courses/` — what is taught and when it meets

The **schedule**. Source: `courses.students.ubc.ca` Drupal JSON:API.

| Table                                                                                                  | Rows      | One row is                                                      |
| ------------------------------------------------------------------------------------------------------ | --------- | --------------------------------------------------------------- |
| `courses`                                                                                              | 38,533    | A course in the catalogue — code, number, credits, description  |
| `sections`                                                                                             | 35,403    | **An actual offering** — days, times, dates, instructor, status |
| `subjects`                                                                                             | 367       | A subject code (`CPSC_V`) and its title                         |
| `terms`                                                                                                | 5         | An academic term                                                |
| `standard_timetables`                                                                                  | 152       | A pre-built first-year timetable, holding section ids           |
| `delivery_modes` · `instructional_methods` · `statuses` · `year_levels` · `program_areas` · `campuses` | 4–12 each | Code lists the above point at                                   |
| `departments`                                                                                          | **0**     | Empty upstream — the resource exists but returns nothing        |

### `data/academic-calendar/` — the rulebook

The **calendar**. Source: `vancouver.calendar.ubc.ca` JSON:API. Note this holds a
_second, different_ course table — see [the two course tables](#the-two-course-tables).

| Table                                                | Rows               | One row is                                                        |
| ---------------------------------------------------- | ------------------ | ----------------------------------------------------------------- |
| `courses`                                            | 9,491              | A course _description_ with prerequisites parsed out of the prose |
| `pages`                                              | 1,453              | Any calendar page — degree requirements, regulations, policies    |
| `programs`                                           | 587                | The subset of pages that sit inside a degree                      |
| `dates`                                              | 53                 | A term start, exam period or withdrawal deadline                  |
| `faculties` · `schools` · `departments` · `subjects` | 13 / 11 / 83 / 264 | The academic hierarchy                                            |
| `academic_years` · `academic_year_terms`             | 364 / 28           | Year and term reference                                           |
| `landing_pages`                                      | 11                 | Top-level section roots                                           |

### `data/geospatial/` — the campus itself

50 files, mirrored verbatim from `UBCGeodata/ubc-geospatial-opendata` at a pinned
commit. Every theme ships a `metadata/` CSV defining its fields. Both GeoJSON and
CSV are provided for most layers.

**`ubcv/locations/`** — the ones you will actually use:

| Layer                    | Features | Geometry                                                                                                               |
| ------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ubcv_buildings`         | 449      | MultiPolygon — footprints, with `BLDG_HEIGHT` and `MAX_FLOORS`                                                         |
| `ubcv_building_entraces` | 1,474    | Point — _(upstream typo in the filename, kept as-is)_                                                                  |
| `ubcv_address`           | 1,230    | Point                                                                                                                  |
| `ubcv_poi`               | 489      | Point — cafés, restaurants, libraries, services, with `HOURS`                                                          |
|                          |          | _(the CSV twins of these carry `LAT`/`LONG`; see [coordinate columns](#coordinate-columns-fixed-here-wrong-upstream))_ |
| `ubcv_subbuildings`      | 140      | Polygon                                                                                                                |
| `ubcv_complexes`         | 50       | MultiPolygon                                                                                                           |

**`ubcv/parking/`** — from a second repo, `UBCGeodata/ubcv-parking`, mounted here
as a theme:

| Layer                         | Features | Note                                                                           |
| ----------------------------- | -------- | ------------------------------------------------------------------------------ |
| `ubcv_parking_www`            | 46       | Point — rates, hours, EV, bike cage, elevator, permit types, HONK payment link |
| `ubcv_parking_www_poly`       | 47       | Polygon — the same facilities as areas, plus `FAC_HEIGHT` clearance            |
| `ubcv_parking_facilities.csv` | 292      | The fuller facility list, including unmapped ones                              |

⚠️ **`ubcv_parking_facilities.csv` is semicolon-delimited.** Parsing it with the
default comma yields a single column whose name is the entire header. Pass
`delimiter=";"`. The two GeoJSON files are unaffected, and their coordinates
were already correct.

Join the point and polygon layers on `FAC_ID`; the CSV keys on `FAC_UID`
instead. Booleans arrive as the strings `"0"`/`"1"`.

**Other themes:** `transportation/` (`ubcv_routes` 7,678 walking/cycling
LineStrings, `ubcv_roads_simple` 221, `ubcv_bollards` 223) · `landscape/`
(`ubcv_campus_trees` 9,324 points, `ubcv_landscape_soft` 4,884, `_hard` 862) ·
`planning/` (`ubcv_neighbourhoods` 12, `ubcv_landuse` 11, `ubcv_legal_boundary`

1. · `context/` (coastline, beach, water, UEL, Pacific Spirit trails 444).

### `ubcv_routes` is a routing network, not just lines

Worth knowing before you reach for anything else: its 7,678 segments carry
`ROAD_TYPE` (Local Access Pathway 2,684 · Sidewalk 1,190 · Crosswalk 657 ·
Trail 537 · Primary Pathway 486 · Street_Crossing 338), plus `PEDESTRIAN_ACCESS`,
`BIKE_ACCESS`, `SURFACE_TYPE`, `SLOPE`, `F_ELEV`/`T_ELEV`, `ONEWAY` and
`STAIRS` (`Y` on 304 segments). That is enough to route a pedestrian, including
avoiding stairs.

### `data/learning-spaces/` — rooms as described

| Table       | Rows | One row is                                                                                 |
| ----------- | ---- | ------------------------------------------------------------------------------------------ |
| `rooms`     | 411  | A classroom (343) or study space (68) — capacity, furniture, layout, photos, derived floor |
| `buildings` | 50   | A building, **carrying its rooms** in floor order, plus totals                             |
| `filters`   | —    | The full vocabulary UBC records per space (A/V, accessibility, features)                   |

### `data/room-bookings/` — rooms as occupied

Library spaces only. **A snapshot**, not a standing fact — see `_snapshot.json`.

| Table          | Rows   | One row is                                                                        |
| -------------- | ------ | --------------------------------------------------------------------------------- |
| `rooms`        | 51     | A bookable library space                                                          |
| `availability` | ~1,000 | An uninterrupted stretch of one room in one state (`free`/`booked`/`unavailable`) |
| `locations`    | 5      | A library publishing bookable space                                               |

### `data/housing/`, `data/libraries/`, `data/student-support/`, `data/policies/`

Undergraduate-focused collections, September 10, 2026 snapshot:

| Table                                                                                        | Rows     | One row is                                                                                           |
| -------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `housing/residences`                                                                         | 14       | An undergraduate-serving residence, with published bed count, quick facts and front-desk contact     |
| `housing/room_types`                                                                         | 12       | A room type linked to those residences                                                               |
| `housing/fee_pages`                                                                          | 16       | A residence or shared summer/early-arrival fee page                                                  |
| `housing/fee_tables`                                                                         | 22       | Labelled numeric fee observations with exact `amount_cents`; periods and variants are not normalized |
| `housing/guidance`                                                                           | 20       | A selected housing application, eligibility, first-year, payment or move-in guidance page            |
| `libraries/branches`                                                                         | 15       | A physical library/service location or virtual service; not necessarily a unique building            |
| `libraries/monthly_schedules`                                                                | 60       | A location's published rules for one calendar month                                                  |
| `libraries/hours`                                                                            | 1,830    | A location and local date, with scheduled times and regular/holiday/exam category                    |
| `student-support/it_services`                                                                | 19       | An IT service explicitly tagged for Students                                                         |
| `student-support/wellbeing_resources`                                                        | 5        | An undergraduate/shared student resource selected by published audience/campus labels                |
| `student-support/learning_commons_pages`                                                     | 34       | A Learning Commons source-index entry; prose belongs to the separate `prose` category                |
| `student-support/*_audiences`, `*_categories`, `wellbeing_campuses`, `wellbeing_populations` | 50 total | A source taxonomy definition                                                                         |
| `policies/index`                                                                             | 17       | An undergraduate-relevant policy's identifiers, dates and canonical URL, not its binding document    |

The four structured groups use plain-string `title`, `source_url`, timestamps and
`record_sha256`. Their field allowlists omit `content_text`, `content_html`
and other copied prose. Use the prose category for normalized explanatory content.

### `data/prose/` — explanatory articles

All normalized prose uses one top-level category with source/topic subcategories,
including `workday`, `student-housing`, `student-services`, `academic-calendar`,
`science-advising`, `arts-advising`, `go-global` and `library`.

Each `prose/<subcategory>/articles.json` is an array of records with `id`,
plain-string `title`, `content_markdown`, `content_sha256`, `source_url`,
`source_modified_at`, `retrieved_at`, `source_records` and `markdown_path`.
The CSV contains the same rows. Standalone `.md` files contain the same Markdown
body. No raw HTML field belongs to this normalized representation.

Read `_coverage.json` and `_inventory.json` before claiming completeness. Counts
refer to declared inventories, with explicit exclusions, inaccessible pages and
processing failures. Older mirrored content keeps its original snapshot time;
conversion does not make it fresh. [PROSE.md](PROSE.md) documents the source scope,
field contract and catalog-led ingestion.

### `data/admissions/` — getting in

| Table                                           | Rows             | One row is                                                                |
| ----------------------------------------------- | ---------------- | ------------------------------------------------------------------------- |
| `programs`                                      | 141              | An undergraduate program in the program finder                            |
| `requirements/program_requirements`             | 141              | program → requirement group _(the first hop of every requirements query)_ |
| `requirements/requirement_groups`               | 20               | A shared requirement group (`arts`, `engineering`…)                       |
| `requirements/locations`                        | 126              | A curriculum you can apply from — 14 provinces, 111 countries, IB         |
| `requirements/by_location`                      | 2,520            | group × location, UBC's prose kept whole                                  |
| `requirements/required_courses`                 | 20,292           | **One requirement line** — the exploded, queryable form                   |
| `degrees` · `interests` · `topics` · `campuses` | 38 / 73 / 10 / 1 | Taxonomies                                                                |
| `pages`                                         | 153              | you.ubc.ca pages on cost, deadlines, how to apply                         |

### `data/finances/` — what it costs

| Table                    | Rows  | One row is                                                       |
| ------------------------ | ----- | ---------------------------------------------------------------- |
| `tuition`                | 1,876 | One (program, column) money cell, melted long                    |
| `student_fees`           | 482   | A Board- or society-approved fee                                 |
| `fee_notes`              | 459   | A row from a fee table carrying no money — footnotes, conditions |
| `program_cost_estimates` | 134   | A program with UBC's first-year estimate attached                |
| `cost_estimates`         | 33    | UBC's own estimate per program area                              |
| `living_costs`           | 10    | A housing, meal or grocery figure                                |

### `data/events/`, `data/people/`, `data/campus-services/`, `data/reports/`

| Table                                    | Rows   | Note                                                                                |
| ---------------------------------------- | ------ | ----------------------------------------------------------------------------------- |
| `events/events`                          | 9,956  | Plus `venues` 199, `organizers` 449, `categories` 58, `tags` 53, and the raw `.ics` |
| `people/profiles`                        | 1,718  | **Partial coverage** — 5 faculty sites only. `_sites.json` records all 43 probed    |
| `campus-services/news`                   | 1,457  | WordPress posts                                                                     |
| `campus-services/student_services_pages` | 464    |                                                                                     |
| `campus-services/facilities_resources`   | 511    |                                                                                     |
| `campus-services/recreation_pages`       | 386    |                                                                                     |
| `campus-services/food_outlets`           | 39     | Rich editorial content, **no coordinates**                                          |
| `campus-services/parking_locations`      | 19     | Page text, no coordinates — for geometry and rates use `geospatial/ubcv/parking/`   |
| `campus-services/statutory_holidays`     | 13     | Includes the two that are UBC's own, not BC's                                       |
| `reports/documents`                      | 194    | An index of published PDFs with direct download URLs                                |
| `reports/*/pages` · `posts`              | 34–234 | The source pages the documents were found on                                        |

---

## The join graph

Match rates below are **measured against the current data**, not assumed.

### Within `courses`

```
sections.related.course          -> courses.id            100%
courses.related.subject          -> subjects.id            99.3%
sections.related.academic_term   -> terms.id               83.3%  (5 of 6 term ids resolve)
```

`related` is a nested object on every Drupal-sourced record holding its foreign
keys. In CSV it arrives JSON-encoded in one cell — parse it, or use the JSON.

```js
const load = (p) => JSON.parse(await readFile(`data/${p}`, "utf8"));
const courses = new Map((await load("courses/courses.json")).map((c) => [c.id, c]));
const sections = await load("courses/sections.json");

for (const s of sections.slice(0, 5)) {
  const course = courses.get(s.related.course);
  console.log(course.field_course_code, s.field_days, s.field_instructors);
}
```

### Buildings — the campus-wide key

`BLDG_CODE` is the closest thing this dataset has to a universal spatial key.

```
learning-spaces/rooms['Building Code']      -> ubcv_buildings.BLDG_CODE   50/50   100%
learning-spaces/buildings['Building Code']  -> ubcv_buildings.BLDG_CODE   50/50   100%
room-bookings/rooms.building_code           -> ubcv_buildings.BLDG_CODE     3/3   100%
room-bookings/rooms.eid                     -> availability.eid           51/51   100%
```

`room-bookings` covers 3 buildings (`IBLC`, `KLIB`, `WLIB`); `learning-spaces`
covers 50. Only `IBLC` is in both — the other two are libraries that Find a Space
does not list.

### Housing and library keys

```text
housing/residences.room_type_ids[] -> housing/room_types.id
housing/residences.fee_page_ids[]  -> housing/fee_pages.id
housing/fee_tables.page_id        -> housing/fee_pages.id
housing/fee_tables.residence_ids[] -> housing/residences.id
libraries/hours.branch_id         -> libraries/branches.id
libraries/hours.schedule_id       -> libraries/monthly_schedules.id
libraries/branches.booking_lid    -> room-bookings/locations.lid
```

`booking_lid` is an explicit crosswalk for five library locations. It is a string,
like the older `lid`; it is **not** `hours_id`. No housing-building-code join is
asserted: the front desk can be in another residence. Research Commons has a
published Koerner address that differs from the older booking dataset's `IBLC`
assignment; do not infer a building match from the location name.

### Admissions → finances

```
finances/program_cost_estimates.program_id  -> admissions/programs.id    134/134  100%
```

The 7 programs without an estimate are in `finances/_unmatched.json` with the
reason, rather than being given a wrong price.

### Admissions requirements

```
program_requirements.(campus, requirement_key)  -> requirement_groups
required_courses.(curriculum, location_slug)    -> locations.(taxonomy, slug)
```

⚠️ **`location_slug` is not unique on its own.** `basic` exists in _both_ the
province and country lists and means something different in each. Filter on
`(curriculum, location_slug)`, or on `location_term_id`, which is unique.

### The two course tables

`courses/courses` (38,533) and `academic-calendar/vancouver/courses` (9,491) are
**different tables** describing overlapping things. The schedule says what is
_offered_; the calendar says what a course _is_ and what it requires.

They do not share a key. Build one:

```js
const load = (p) => JSON.parse(await readFile(`data/${p}`, "utf8"));
const subjects = new Map((await load("academic-calendar/vancouver/subjects.json")).map((s) => [s.id, s.name]));

// 'AANB_V 550' -- matches courses/courses.field_course_code.
function calendarCode(row) {
  const name = subjects.get(row.related?.course_code);
  const number = row.field_course_number;
  return name && number != null ? `${name} ${number}` : null;
}
```

**8,109 of 9,489 constructible codes match (85.5%).** The shortfall is real:
those are calendar courses with no current scheduled offering. 2 calendar rows
carry `related.course_code == "missing"` and cannot be keyed at all.

Which to use:

| Question                                       | Table                                                                   |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| When does it meet, who teaches it, is it full? | `courses/sections`                                                      |
| What are the prerequisites?                    | either — `courses/courses` has them at 40%, calendar at higher fidelity |
| What does the course actually cover?           | `academic-calendar/.../courses`                                         |

### Joins that do **not** exist

These look like they should work and don't. Verified:

| Attempted                                             | Result                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `sections` → any room or building                     | **No such field.** Not in the snapshot, not in the live API, not on the rendered page. Room assignment is not published. |
| `people/profiles.field_profile_office` → `BLDG_CODE`  | **2.9%** (6/206). It is free text — `"EDC 235"`, `"KAISER 5000"`, `"PPC"` — not a key.                                   |
| `campus-services/food_outlets` → `ubcv_poi.PLACENAME` | **59%** on exact name. Usable with fuzzy matching; not a clean key.                                                      |
| `events/venues` → geospatial                          | No coordinates and no building code. Only `address`/`city` as a proxy.                                                   |

---

## Encodings and traps

### Coordinate columns: fixed here, wrong upstream

UBC ships five CSVs under `ubcv/locations/csv/` with their coordinate columns
labelled the wrong way round — `LAT` holding longitude, `LONG` holding latitude.
**This is corrected on the way in**, so `LAT` and `LONG` hold what they say:

```
ubcv_address.csv   ubcv_address_mailing.csv   ubcv_buildings.csv
ubcv_buildings_simple.csv   ubcv_poi.csv
```

Only the header names are swapped; every data row is byte-identical to upstream.
The practical consequence is that these five files end `…,LONG,LAT` rather than
`…,LAT,LONG`. **Read them by name, not by position.** The correction and the
files it touched are recorded in `data/geospatial/_source.json` under
`corrections`, and the detection is arithmetic — a latitude cannot fall outside
±90 — so it stops applying by itself if UBC fixes it at source.

The GeoJSON versions were always correct and are untouched.

Two files that look similar and are **not** affected:

- `ubcv_campus_trees.csv` — already the right way round upstream.
- `off-campus/.../ubc_regional_locations.csv` — ⚠️ **still needs care.** Its
  `LAT`/`LONG` are a projected CRS in metres, not degrees (Langley is
  `1247689, 459066`), and they are in X,Y order — so `LAT` is an easting. No
  header swap can fix that, because a northing renamed `LAT` is still not a
  latitude. **Use `ubc_regional_locations.geojson`**, which is proper WGS84
  `[lon, lat]`.

### Section times are seconds from midnight

`field_start_time` / `field_end_time` are integers, range 25200–73800
(07:00–20:30).

```js
const h = Math.floor(section.field_start_time / 3600);
const m = Math.floor((section.field_start_time % 3600) / 60);
// 34200 -> (9, 30) -> 09:30      50400 -> (14, 0) -> 14:00
```

`field_days` is a list from `{"m", "t", "w", "th", "f"}` — note `t` is Tuesday
and `th` is Thursday. No weekend sections exist in the current data.

### Availability is a snapshot

Everything in `data/room-bookings/availability` was true at `collected_at` and
may not be now. Re-run `npm run update -- bookings` (~5s) before relying on it.
Row counts shift between runs because people book rooms.

Intervals are merged runs of 15-minute slots. To recover the raw grid, subdivide:
a 120-minute interval is 8 slots. `_snapshot.json` records `slots_seen` so the
underlying volume stays visible.

### Drupal bodies are HTML, not text

`body` on calendar pages, programs and profiles is an object:

```json
{ "value": "<p>…</p>", "format": "filtered_text", "processed": "<p>…</p>", "summary": null }
```

Use `body["processed"]` and strip tags. WordPress-sourced tables
(`campus-services/*`, `admissions/pages`, `events`) nest differently:
`title["rendered"]`, `content["rendered"]` — and `content` can be a large
Elementor blob, as in `food_outlets`.

### Housing instalments and library opening hours

A housing fee table can mix contract totals, deposits, acceptance payments and
instalments. Each `values` observation retains `row_label`, `column_label`,
`period_label`, `amount_text`, exact `amount_cents` and `footnote_markers`.
A source blank or dash becomes null, not zero. `source_context_required` remains
true because short numeric labels do not reproduce all eligibility and fee
conditions. The `prose/student-housing` articles retain explanations and
link to structured rows through `source_records`; still check their timestamps
and the official page. Do not multiply a monthly payment by twelve or add
instalments to a total that already includes them.

`libraries/hours` uses `HH:mm` local wall times, not seconds after midnight.
`closes_next_day: true` handles midnight and overnight closings. Its `status` is
`open`, `closed` or `unknown`; `open` describes that date's scheduled hours, not
current availability. The source supplies no timezone offset, so the documented
interpretation is `America/Vancouver`. Dates outside the collected four-month
window are unknown.

Wellbeing's literal `missing` relationship targets have no available taxonomy
label. `unavailable_relationships` and `_unavailable.json` identify them; they are
not foreign keys. Unknown non-sentinel IDs cause collection to fail.

### Course text fill rates

`courses/courses` parses prerequisites out of description prose. Coverage is
uneven, and querying it as if complete will silently under-report:

| Field              | Filled |
| ------------------ | ------ |
| `field_credits`    | 100%   |
| `description_text` | 86%    |
| `prerequisite`     | 40%    |
| `hours_vector`     | 20%    |
| `credit_exclusion` | 7%     |
| `corequisite`      | 4%     |

### Airtable photo URLs expire

`cover_photo_url` in `learning-spaces` dies within a day. `cover_photo_expires`
gives the deadline; `Room Link` re-renders a fresh one on load.

### Missing booking days and opening hours

If a date is absent from `room-bookings/_snapshot.json`'s `days_served`, UBC
published no slots for it. Do not extend that booking-snapshot convention to the
`libraries/hours` table: it stores closed and unknown days explicitly. Use the
dated library rules to check opening hours and retain uncertainty when no rule is
available; a lack of booking slots is not a general opening-hours guarantee.

---

## Recipes

### Read a Workday explanation with its citation

```js
const articles = JSON.parse(await readFile("data/prose/workday/articles.json", "utf8"));
const article = articles.find((row) => /saved schedule/i.test(row.title));
console.log(article.title, article.source_url, article.retrieved_at);
console.log(article.content_markdown);
```

Use the same plain-title/Markdown schema across prose subcategories rather than
the older WordPress/Drupal field shapes.

### Find a free study room with seats, and put it on a map

```js
const load = (p) => JSON.parse(await readFile(`data/${p}`, "utf8"));
const availability = await load("room-bookings/availability.json");
const geo = await load("geospatial/ubcv/locations/geojson/ubcv_buildings.geojson");

const where = new Map();
for (const f of geo.features) {
  const code = f.properties.BLDG_CODE;
  let coords = f.geometry.coordinates;
  while (Array.isArray(coords[0])) coords = coords[0];
  if (!where.has(code)) {
    where.set(code, { name: f.properties.NAME, lat: coords[1], lon: coords[0] });
  }
}

const hits = availability.filter(
  (a) => a.state === "free" && a.minutes >= 120 && (a.capacity || 0) >= 8,
);

for (const a of hits.sort((x, y) => y.capacity - x.capacity).slice(0, 5)) {
  const b = where.get(a.building_code);
  console.log(
    `${a.room.padEnd(30)} ${String(a.capacity).padStart(3)} seats  ${a.start.slice(11, 16)}-${a.end.slice(11, 16)}`,
  );
  console.log(`   ${b.name}  ${b.lat.toFixed(5)},${b.lon.toFixed(5)}`);
}
```

### What does Engineering require, from BC?

```js
const req = await load("admissions/requirements/required_courses.json");
const rows = req.filter(
  (r) => r.requirement_key === "engineering" && r.location_slug === "british-columbia" && !r.advisory,
);
```

`advisory` separates hard gates from `suggested_subjects` and
`recommended_grade_range`, which UBC offers as advice.

### When is a course taught, and by whom?

```js
const courses = new Map((await load("courses/courses.json")).map((c) => [c.id, c]));
const sections = await load("courses/sections.json");
const DAYS = { m: "Mon", t: "Tue", w: "Wed", th: "Thu", f: "Fri" };

for (const s of sections) {
  const c = courses.get(s.related?.course);
  if (c && c.field_course_code === "CPSC_V 110" && s.field_start_time) {
    const days = s.field_days.map((d) => DAYS[d]).join(" ");
    const h = Math.floor(s.field_start_time / 3600);
    const m = Math.floor((s.field_start_time % 3600) / 60);
    console.log(
      `${s.field_section_number.padEnd(6)} ${days.padEnd(16)} ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}  ${s.field_instructors}`,
    );
  }
}
```

### Cafés open near a point

```js
const poi = await load("geospatial/ubcv/locations/geojson/ubcv_poi.geojson");
const cafes = poi.features.filter((f) => ["cafe", "restaurant"].includes(f.properties.SERVICE_TYPE));
// f.geometry.coordinates is [lon, lat] and is correct here.
// f.properties.HOURS is free text: "M-F: 7 am - 9 pm; Sat-Sun: 8 am - 5 pm"
```

`SERVICE_TYPE` counts: `cafe` 69, `campus_services` 61, `academic` 36,
`commercial_services` 34, `child_care` 30, `restaurant` 27, `medical` 23,
`library` 17, `grocery` 15, `bank` 7, `transit` 3.

### What will first year cost?

```js
const est = await load("finances/program_cost_estimates.json");
const row = est.find((r) => r.program.startsWith("Computer Science"));
console.log(row.educational_total_domestic, row.educational_total_international);
console.log("matched to estimator area by:", row.matched_by);
```

Always surface `matched_by` — nothing upstream links a program to an estimator
area, so the match is name-based and its confidence varies.

---

## What this data cannot answer

Stated plainly so you don't build on sand:

| Question                              | Why not                                                                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Which room is my lecture in?**      | The public JSON:API, rendered section pages and course-search app expose no section-to-room mapping.                          |
| **When is lecture hall X free?**      | Same cause. `room-bookings` covers 51 library spaces, not the 343 classrooms.                                                 |
| **Where is Professor Y right now?**   | 494/1,718 profiles have an office string, in no consistent format; office _hours_ aren't in the data at all.                  |
| **What's inside a building?**         | Footprints are 2D. `BLDG_HEIGHT` + `MAX_FLOORS` support extrusion to 2.5D, but there are no floor plans or interior geometry. |
| **How full is this class?**           | No enrolment counts, no waitlists, no historical class sizes.                                                                 |
| **What grade did an individual get?** | No individual student records. `grades/` holds historical aggregates from a third-party mirror, not personal results.         |
| **Anything about Okanagan**           | Vancouver-only by default. Re-run with `--campus both`.                                                                       |

---

## Refreshing

```bash
npm run update                    # everything
npm run update -- bookings        # just availability (~5s, snapshot — re-run often)
npm run update -- --list          # what's available
npm run update -- --min-interval 300 # milliseconds between requests
npm run update -- housing libraries support policies
npm run validate:undergrad          # offline consistency checks for structured facts
npm run collect:prose               # refresh Markdown article exports
npm run validate:prose              # safety, byte equality and inventory accounting
```

For housing TLS setup and source-specific limits, see
[the undergraduate refresh guide](UNDERGRADUATE-SOURCES.md#refresh-and-verification).

A group that fails is recorded in the manifest with its error; the rest of the
run continues. After a group succeeds, files it didn't write are pruned, so
renamed or retired datasets don't linger and read as current.
