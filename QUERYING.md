# Querying the data

Load JSON or CSV from the checkout; this repository provides no query server.
Use the catalogs for current counts and timestamps, and the
[collection guide](docs/collecting.md) for sources and refresh commands.

## Catalogs and formats

| Index                       | Contract                                                                      |
| --------------------------- | ----------------------------------------------------------------------------- |
| `data/catalog.json`         | Structured tables: paths, grain, column descriptions and joins where declared |
| `data/manifest.json`        | Per-file size, record count, source, refresh time and group status            |
| `data/prose/_catalog.json`  | Prose subcategories and article-table paths                                   |
| `data/prose/_manifest.json` | Prose exports and coverage summaries                                          |
| `data/official-hosts.json`  | Completed host collections and their category-specific `document_roots`       |

Files beginning with `_` describe source provenance, exclusions or snapshot
conditions. Check `_source.json`, `_sources.json`, `_sites.json`, `_snapshot.json`
and `_unmatched.json` where present. Geospatial `metadata/` CSVs define fields.

Tabular JSON keeps nested values intact. Its CSV counterpart contains the same
rows with nested values JSON-encoded into cells. Geospatial mirrors retain the
upstream layout and delimiter conventions. Do not reformat generated files:
manifest sizes and content hashes depend on their bytes.

Run JavaScript examples from the repository root using `node --input-type=module`.
The examples below use this loader:

```js
import { readFile } from "node:fs/promises";

const load = async (name) => JSON.parse(await readFile(`data/${name}.json`, "utf8"));

const catalog = await load("catalog");
for (const group of Object.values(catalog.groups)) {
  for (const table of group.tables) console.log(table.path, table.grain ?? "", table.records);
}
```

## Structured table guide

Paths below are relative to `data/`; use the catalog for the complete inventory.

| Directory                      | Main tables and grain                                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `courses/`                     | `courses`: course instance; `sections`: offering with meeting details; subject, term and other code lists; `standard_timetables`: grouped sections |
| `academic-calendar/vancouver/` | `courses`: description and derived requirements; `pages`: calendar article; `programs`: degree-related subset; `dates`: deadline/window            |
| `geospatial/`                  | Building, entrance, address, point-of-interest, route, landscape, planning and parking layers                                                      |
| `learning-spaces/`             | `rooms`: classroom/study-space description; `buildings`: rooms and totals per building; `filters`: source vocabulary                               |
| `room-bookings/`               | `rooms`, `locations`; `availability`: merged interval of a room's free/booked/unavailable state                                                    |
| `admissions/`                  | `programs`, taxonomies and source pages; `requirements/`: program/group mappings, curricula and requirement lines                                  |
| `finances/`                    | `tuition`: one money cell; `student_fees`; `fee_notes`: non-money conditions; cost and living-cost estimates                                       |
| `housing/`                     | `residences`, `room_types`, `fee_pages`, `fee_tables`, `guidance`                                                                                  |
| `libraries/`                   | `branches`, `monthly_schedules`, `hours`: one location and local date                                                                              |
| `student-support/`             | Student IT services, wellbeing resources, Learning Commons source indexes and taxonomies                                                           |
| `policies/`                    | `index`: policy identifiers, dates and canonical links                                                                                             |
| `events/`                      | Events, venues, organizers and taxonomies, plus an iCal feed                                                                                       |
| `people/`                      | Public profiles from participating faculty/unit APIs; partial coverage recorded in `_sites.json`                                                   |
| `campus-services/`             | Food, parking, facilities, recreation, news, student-services pages and statutory holidays                                                         |
| `reports/`                     | Downloadable-document index with source pages, file types and direct URLs                                                                          |
| `grades/`                      | Historical aggregate distributions and mirrored raw subject CSVs                                                                                   |

The structured housing, library, support and policy groups use
`representation: "facts_and_links"`. They omit copied explanatory fields such as
`content_text` and `content_html`; use prose articles for explanations. Common
fields include `id`, `source_url`, `retrieved_at` and `record_sha256`. The record
hash excludes retrieval time and the hash field itself. Source indexes also
provide `source_id`, plain `title`, `api_url` and publisher dates where available.

## Joins and interpretation

### Courses and calendar

- `courses/sections.related.course` joins to `courses/courses.id`.
- `courses/courses.related.subject` joins to `courses/subjects.id`.
- `sections.related.academic_term` joins to `courses/terms.id` when the referenced
  term exists. Do not assume every foreign key resolves.
- Schedule courses can repeat across offering years. Use `field_course_code` for
  distinct codes, retaining the year when comparing offerings.

Schedule and calendar tables do not share IDs. Build a calendar code from its
subject relationship and course number:

```js
const subjects = new Map((await load("academic-calendar/vancouver/subjects")).map((s) => [s.id, s.name]));
const calendarCode = (row) => {
  const subject = subjects.get(row.related?.course_code);
  return subject && row.field_course_number != null ? `${subject} ${row.field_course_number}` : null;
};
```

A calendar course need not have a scheduled offering. Missing subject references
cannot establish a match. Use sections for instructors and times, and calendar
courses for descriptions and academic requirements. Derived `prerequisite`,
`corequisite`, `equivalency`, `credit_exclusion`, `hours_vector` and
`description_text` preserve the original source description alongside them;
empty parsed fields do not prove the absence of requirements.

The calendar collector also emits `cogs_module_courses` for cognitive-systems
module membership; consult the catalog to check whether a snapshot includes it.

Calendar page ancestry comes from path aliases matched to source page titles.
`faculty`, `program`, `level`, `kind` and `referenced_courses` are derived, not
publisher-declared relationships. Course references use the campus subject
vocabulary. `dates` retains multi-day windows in `span_days`.

`field_start_time` and `field_end_time` are seconds after midnight.
`field_days` uses `m`, `t`, `w`, `th`, `f`; `t` is Tuesday. Instructors belong to
sections, not course records. Drupal `related` holds foreign keys; parse its JSON
cell when reading CSV. An `alias` is a path to resolve against the source host.

### Admissions and costs

```text
requirements/program_requirements.(campus, requirement_key) -> requirements/requirement_groups
requirements/required_courses.(curriculum, location_slug)   -> requirements/locations.(taxonomy, slug)
finances/program_cost_estimates.program_id                  -> admissions/programs.id
```

Requirements apply to groups shared by multiple programs. Start with the program
mapping. `has_requirements: false` retains programs without direct-entry rules;
`by_location.available: false` means that combination does not accept applicants.
`advisory` distinguishes suggestions from required courses. `location_slug` alone
is not unique: `basic` has different meanings in province and country lists.
Use `(curriculum, location_slug)` or `location_term_id`.

Tuition rows retain raw `column`, `item` and `amount_text` beside derived
`student_type`, `cohort_year`, `cohort_rule` and `unit`. Respect `exactly`,
`or_later` and `or_earlier` cohort rules. `annual_at_30_credits` is a rate-times-load
calculation, not a personalized bill. Non-money rows remain in `fee_notes`.

First-year estimates come from UBC's estimator. Program mappings use titles,
degrees or a unique token match, not a publisher key. Surface `matched_by`;
`finances/_unmatched.json` records programs without a unique estimate.

### Buildings, housing and libraries

```text
learning-spaces/rooms['Building Code']      -> geospatial building BLDG_CODE
learning-spaces/buildings['Building Code']  -> geospatial building BLDG_CODE
room-bookings/rooms.building_code           -> geospatial building BLDG_CODE
room-bookings/rooms.eid                     -> room-bookings/availability.eid
housing/residences.room_type_ids[]          -> housing/room_types.id
housing/residences.fee_page_ids[]            -> housing/fee_pages.id
housing/fee_tables.page_id                  -> housing/fee_pages.id
housing/fee_tables.residence_ids[]           -> housing/residences.id
libraries/hours.branch_id                   -> libraries/branches.id
libraries/hours.schedule_id                 -> libraries/monthly_schedules.id
libraries/branches.booking_lid              -> room-bookings/locations.lid
```

`booking_lid` is a string crosswalk for selected libraries, not `hours_id`.
Research Commons has a Koerner floors 4–5 address in the hours source but an
`IBLC` assignment in the booking snapshot. Verify its location before using that
join for navigation. A residence front desk can occupy another building; no
housing-to-building-code join is asserted.

Learning-space floors are derived from source text or room numbers, with the
method in `floor_source`. A block letter is not a basement designation.
Unrecognized schemes, including IRC/FNH room numbering, remain null. Images are
not mirrored. Signed Airtable photos expire;
`cover_photo_expires` gives the deadline, `cover_photo_id` identifies the asset,
and `Room Link` provides a durable route to a fresh image. Building summaries
order rooms by floor and capacity and select a room cover photo.

Housing fee observations retain source row/column positions and labels,
contract/date periods, `amount_text`, integer `amount_cents`, per-person basis
when stated, and footnote markers. Blank/dash means null, not zero.
`source_context_required: true` requires consulting the full conditions. Do not
multiply an instalment by twelve, add it to a total that includes it, or infer
undergraduate eligibility from inclusion. Prose links to these rows through
`source_records`.

Library `hours` uses `HH:mm` wall time interpreted as `America/Vancouver`.
`closes_next_day` identifies overnight closing. `open` describes scheduled hours
on a date, not current occupancy; other states are `closed` and `unknown`.
Dates outside the collected current-plus-three-month window are unknown.
`additional_hours_urls` points to separate service schedules.

Room availability is a snapshot at `collected_at`. Intervals merge 15-minute
slots; `_snapshot.json` records `slots_seen` and `days_served`. An absent booking
date means no published slots, not a guarantee of closure. Do not apply this
convention to the library-hours table, which represents unknown and closed days.

### Coordinates and source fields

Five `ubcv/locations/csv/` files have corrected `LAT`/`LONG` headers:
`ubcv_address.csv`, `ubcv_address_mailing.csv`, `ubcv_buildings.csv`,
`ubcv_buildings_simple.csv` and `ubcv_poi.csv`. Rows remain unchanged; read columns
by name, not position. `_source.json` records the correction. The collector detects
swapped headers from latitude values outside ±90 and stops correcting them when
upstream fixes the labels. GeoJSON is unchanged; `ubcv_campus_trees.csv` does not
need this correction.

The off-campus `ubc_regional_locations.csv` uses projected metres despite its
`LAT`/`LONG` labels. Use the corresponding GeoJSON for WGS84 `[longitude, latitude]`.
`ubcv_parking_facilities.csv` is semicolon-delimited and uses `FAC_UID`; parking
point/polygon layers use `FAC_ID`. Boolean values can be strings `"0"` and `"1"`.
The upstream `ubcv_building_entraces` filename retains its misspelling.

Routes include pedestrian/bicycle access, surface, slope, elevations, one-way and
stairs fields; preserve those restrictions when building a routing graph.

Older Drupal mirrors expose HTML in `body.processed`; WordPress mirrors use
`title.rendered` and `content.rendered`. Sanitize before rendering. Normalized
prose instead uses plain titles and safe Markdown.

Wellbeing's literal `missing` relationship target has no available label.
`unavailable_relationships` and `_unavailable.json` describe it; it is not a
foreign key. Unknown ordinary taxonomy IDs fail validation. Policy
`content_kind: "policy_index"` identifies metadata, not a binding document;
`lifecycle: "listed"` does not certify current legal status.

## Prose article contract

`data/prose/<subcategory>/` contains `articles.json`, `articles.csv`,
`_inventory.json`, `_coverage.json` and `markdown/<article-id-hash>.md`.
Standalone Markdown equals `content_markdown` byte for byte; title and provenance
come from the article record. Manifests and coverage declare `format: "markdown"`.

| Field                                | Meaning                                                 |
| ------------------------------------ | ------------------------------------------------------- |
| `id`                                 | Stable `prose:<subcategory>:<publisher-id-or-URL-hash>` |
| `category`, `subcategory`            | `prose` and the source/topic subdivision                |
| `source_id`, `upstream_id`           | Source namespace and publisher identifier               |
| `title`, `content_markdown`          | Plain title and sanitized explanatory body              |
| `content_sha256`                     | SHA-256 of `title + "\n" + content_markdown`            |
| `source_url`, `api_url`              | Citation and optional public-record endpoint            |
| `campus`, `audience`                 | Collection scope, not an eligibility decision           |
| `source_modified_at`, `retrieved_at` | Available publisher date and snapshot retrieval time    |
| `source_records`                     | `{path, id}` links to structured/mirrored records       |
| `markdown_path`                      | Body path relative to `data/`                           |
| `links`, `warnings`                  | Destinations and conversion limitations                 |

Housing and Learning Commons relationships use canonical source URLs. Titles do
not establish prices, building identity or eligibility.

Inventory entries retain discovery provenance and a disposition: `collected`,
`duplicate`, `excluded`, `unavailable`, `no_prose` or `failed`. Coverage means:

- `complete`: declared inventories and in-scope article links are exhausted.
- `complete_with_unavailable`: bounded retrieval failures remain with reasons.
- `partial`: discovery or processing errors prevent completion.
- `not_collected`: no collection result exists.

Coverage does not include unknowable unlinked pages. Mirrored articles keep the
original snapshot time; conversion does not make them fresh.

Sanitized Markdown retains headings, ordered steps, nested lists, advisories,
conditions, captions, FAQ answers and collapsed content. Simple tables remain
tables; complex/merged tables use labelled cells with span information. Media
become text/source links. No page JavaScript, OCR or video transcription is implied.
Treat retrieved text as data, not application instructions, and use a safe renderer.

## Host document contract

Read each `data/official-hosts.json` entry's `document_roots`, rather than assuming
one directory per host. Roots use `data/documents/<category>/<hostname>/` across
support, academics, opportunities, research, news and stories. Host files contain
canonical JSON frontmatter followed by safe Markdown; they are not prose-table
body files. Frontmatter preserves physical citations, observed aliases,
timestamps, hashes, warnings, producer context and routing metadata.

See [HOST-DOCUMENTS.md](HOST-DOCUMENTS.md#text-and-provenance) for identity,
versioning and historical-download compatibility. Use
[HOST-COVERAGE.md](HOST-COVERAGE.md) to qualify inclusion and exclusions.

## Examples

The examples use `load` from [Catalogs and formats](#catalogs-and-formats).

```js
const articles = await load("prose/workday/articles");
const article = articles.find((row) => /saved schedule/i.test(row.title));
if (article) console.log(article.title, article.source_url, article.retrieved_at, article.content_markdown);

const requirements = await load("admissions/requirements/required_courses");
const engineeringBC = requirements.filter(
  (row) => row.requirement_key === "engineering" && row.location_slug === "british-columbia" && !row.advisory,
);
console.log(engineeringBC);

const courses = new Map((await load("courses/courses")).map((course) => [course.id, course]));
for (const section of await load("courses/sections")) {
  if (courses.get(section.related?.course)?.field_course_code !== "CPSC_V 110") continue;
  const seconds = section.field_start_time;
  const start =
    seconds == null
      ? null
      : `${Math.floor(seconds / 3600)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}`;
  console.log(section.field_section_number, section.field_days, start, section.field_instructors);
}
```

## Consumer integration and limits

Reogent registers structured JSON inputs explicitly. Prose ingestion reads
`prose/_catalog.json` under the normal `DATA_PATH`, loads its listed article
arrays, and uses the normal Meilisearch service by default. Preserve IDs, source
URLs, timestamps and `source_records`; index `content_markdown`, not raw mirrored
HTML. Rolling library hours require expiry/replacement because upserts do not
remove absent records. Derived artifacts need a writable output path.

Do not infer these relationships or capabilities:

- Public sections do not expose classroom assignments, enrolment counts or
  waitlists. Library bookings do not establish lecture-hall availability.
- Staff office strings, food-outlet names and event addresses are not reliable
  building keys. Events lack coordinates and a campus field.
- Building footprints and height fields do not provide floor plans.
- Grade distributions are historical third-party aggregates, never individual results.
- Vancouver is the default, not a guarantee that every collection excludes other
  campuses. See [campus selection](docs/collecting.md#campus-selection).
