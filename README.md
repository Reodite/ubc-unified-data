# Unified UBC Data

A dataset of public institutional data about the University of British Columbia,
gathered from official UBC sources and kept in plain JSON/CSV/GeoJSON files.

The goal is the stuff that helps students: where things are, what's taught, when
it's taught, where you can sit down and study, what it costs, who teaches it,
and what's happening on campus. **No individual student records.** The existing
`grades` collection contains historical aggregate distributions from a third-party
mirror, not a direct, current UBC feed.

Housing, library, student-support and policy collections focus on **undergraduates**.
See [UNDERGRADUATE-SOURCES.md](UNDERGRADUATE-SOURCES.md) for official sources,
coverage, exclusions, refresh instructions and Reogent integration.
[PROSE.md](PROSE.md) describes the unified `prose` category and its Markdown
corpus, organized into subcategories such as `workday` and `student-housing`.

```text
Unified-UBC-Data/
├── src/           # code that gathers the data
├── data/          # the data itself
└── package.json   # npm run update refreshes everything
```

## What's in here

| Group        | Folder                    | What you get                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `geospatial` | `data/geospatial/`        | Buildings, entrances, sub-buildings, complexes, addresses, points of interest, campus trees, hard/soft landscape, water features, roads, routes, bollards, land use, neighbourhoods, legal boundaries. GeoJSON + CSV, mirrored verbatim apart from one recorded correction: five `ubcv/locations/csv/` files label `LAT`/`LONG` the wrong way round upstream, and the two column names are swapped back. Data rows are untouched; see `_source.json` → `corrections`.                                                                                                       |
| `courses`    | `data/courses/`           | Two tables. `courses.*` is the catalogue (code, number, title, credits, subject, description). `sections.*` is every **actual offering** (term, meeting days and times, start/end dates, instructor, delivery mode, status). Plus subject, campus, term, year-level and department code lists, and standard timetables.                                                                                                                                                                                                                                                     |
| `calendar`   | `data/academic-calendar/` | The course _catalogue_: descriptions and credit values, plus prerequisites, corequisites, equivalencies, credit exclusions and hours vectors **parsed out of the description prose** (see below), plus the faculty / school / department hierarchy. Also every calendar _page_: `pages.*` is the whole site (degree requirements, faculty overviews, admission rules, regulations) with body text, breadcrumbs and the courses each page references; `programs.*` is the subset that sits inside a degree; `dates.*` is term start/finish, exam periods and drop deadlines. |
| `spaces`     | `data/learning-spaces/`   | Bookable classrooms and informal study spaces with capacity, building, room number, **derived floor**, furniture and layout style, photos and links. `buildings.*` carries the rooms in each building (name, floor, capacity, cover photo) plus their totals and a building cover photo. `filters.json` holds the full vocabulary UBC records per space (A/V, accessibility, room features).                                                                                                                                                                                |
| `events`     | `data/events/`            | Public events with times, cost, description and category, plus venues (street address, city, postal code) and organizers (email, phone, website). Includes the raw iCal feed. Venues have no coordinates; join them to `geospatial/ubcv/locations/` on address or building to place them on a map.                                                                                                                                                                                                                                                                          |
| `admissions` | `data/admissions/`        | Every undergraduate program in the program finder with degree, campus, faculty and areas of interest; the degree list; the you.ubc.ca pages on requirements, costs, deadlines and how to apply. And in `requirements/`, **what each program demands of an applicant** (the required Grade 11 and 12 courses, general admission rules and English-language rules) for every one of the 126 curricula a student can apply from (see below).                                                                                                                                   |
| `finances`   | `data/finances/`          | What it costs. Per-credit tuition by program for domestic and international students, with the cohort year each international rate is frozen at; flat-rate and per-instalment programs; graduate and certificate rates; Board- and society-approved student fees; UBC's own first-year cost estimate for all 33 program areas plus the housing, meal, rent and grocery figures behind it; and a per-program estimate joining the two.                                                                                                                                       |
| `people`     | `data/people/`            | Public faculty and staff profiles, tagged with the site each came from. **Partial coverage:** only 5 of 43 probed UBC sites expose profiles over an API: Applied Science, Nursing, Law, Pharmaceutical Sciences and Science (1,712 profiles). The rest (Arts, Sauder, Medicine, Forestry, Education, Grad Studies…) aren't on the shared Drupal platform and return no `/jsonapi`. `_sites.json` records which host gave what.                                                                                                                                              |
| `services`   | `data/campus-services/`   | Food outlets, parking locations, permits and parking maps, facilities and learning-space resource libraries, recreation and student-services pages, UBC news, and the statutory holidays UBC observes (including the two that are UBC's own rather than BC's).                                                                                                                                                                                                                                                                                                              |
| `reports`    | `data/reports/`           | An index of UBC's published institutional documents (annual financial reports, budgets, Statements of Financial Information, annual enrolment reports, Facts & Figures), each with a direct download URL, file type and source page. Rates and fees are not here; they are in `finances`.                                                                                                                                                                                                                                                                                   |

## Undergraduate collections

Four groups cover undergraduate services. Counts describe the September 10, 2026
snapshot:

| Group       | Folder                  | Coverage                                                                                                                                     |
| ----------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `housing`   | `data/housing/`         | 14 undergraduate-serving residences, 12 room types, 16 fee pages with 22 fee tables, and 20 selected application/first-year guidance pages   |
| `libraries` | `data/libraries/`       | 15 physical/virtual library-service locations and 1,830 dated opening-hour records across four months, including holiday and exam exceptions |
| `support`   | `data/student-support/` | 19 student-facing IT services, 5 undergraduate/shared wellbeing resources, 34 Learning Commons pages, and their taxonomy definitions         |
| `policies`  | `data/policies/`        | 17 undergraduate-relevant policy index records with canonical links, identifiers and dates; explanatory prose belongs to `prose`             |

The four groups contain structured facts and source-link indexes, with citation
URLs, timestamps and record hashes. Housing fee observations retain numeric
values and short labels; consult the source for conditions. Library hours
describe schedules, not room availability.

Explanatory content lives under **`data/prose/<subcategory>/`** as common article
arrays, CSV exports and standalone sanitized Markdown. Its own `_catalog.json`,
`_manifest.json` and per-source coverage ledgers distinguish complete inventories,
exclusions and failures. The repository includes these generated exports.
Run `npm run collect:prose` to refresh them and `npm run validate:prose` before
committing. Raw response caches remain under the ignored `.cache/prose/` directory.

See [PROSE.md](PROSE.md) for collection, schemas and limitations, and the
[source guide](UNDERGRADUATE-SOURCES.md) for structured-data qualifications and
the housing certificate-chain workaround.

## Finding your way around

**[QUERYING.md](QUERYING.md) is the query reference**: every table and where it
lives, the join graph with measured match rates, the encodings that will trip you
up (section times are seconds from midnight; five geospatial CSVs had their
`LAT`/`LONG` headers swapped upstream and are corrected here), worked recipes,
and an explicit list of what this data _cannot_ answer. Start there to get an
answer; read on to see how the data is gathered.

`data/catalog.json` indexes tables: each entry gives the grain (what one row
_is_), the columns worth knowing, and the joins that link it to other tables.
Read it before guessing from filenames.

```json
{
  "name": "required_courses",
  "path": "admissions/requirements/required_courses",
  "json": "admissions/requirements/required_courses.json",
  "csv":  "admissions/requirements/required_courses.csv",
  "records": 20292,
  "grain": "one requirement line -- the exploded form of by_location, and the table
            to query when the question is 'what do I need to have taken?'",
  "joins": ["(campus, requirement_key) -> requirements/requirement_groups",
            "(curriculum, location_slug) -> requirements/locations.(taxonomy, slug)"]
}
```

`data/manifest.json` carries the same information plus per-file byte sizes,
source URLs, timestamps and run status. Collectors declare grain and joins with
`out.describe(...)`; datasets that haven't been described yet still appear,
without those fields.

## Admission requirements

What UBC asks of an applicant depends on where they went to school, so it is not
on the program page; the page ships a dropdown and fetches the rules for
whichever province, country or curriculum you pick. `admissions/requirements/`
drives the same endpoint across every combination.

Two facts shape the data before you query it:

- **Requirements are shared between programs.** All 41 Arts majors ask the same
  thing, so UBC keys them by a _requirement group_ (`arts`, `engineering`,
  `commerce`…), not by program. 122 direct-entry Vancouver programs map to 20
  groups. `program_requirements` is that mapping, and it is the first hop of
  every query.
- **19 programs have no direct-entry rules:** Medicine, Law, Dentistry,
  Journalism, Architecture and the rest are graduate-entry or second-degree.
  They are still rows, with `has_requirements: false` and a note saying why,
  rather than quietly missing.

```text
program_requirements   141 rows   program -> requirement_key
requirement_groups      20 rows   the groups, and which programs use each
locations              126 rows   14 provinces, 111 countries, IB
by_location          2,520 rows   group x location, UBC's prose kept whole
required_courses    20,292 rows   the same thing exploded, one row per requirement
```

So "what do I need for Engineering from BC?" is a filter on `required_courses`
for `requirement_key = engineering`, `location_slug = british-columbia`,
`advisory = false`:

```text
grade_12          English Studies 12 or English First Peoples 12
grade_12          Pre-Calculus 12
grade_12          Chemistry 12 (outstanding candidates missing Chemistry 12 ... )
grade_12          Physics 12 (outstanding candidates missing Physics 12 ... )
grade_11          Chemistry 11
grade_11          Physics 11
general           Graduation from high school
general           Minimum of 70% in Grade 11 or Grade 12 English (or their equivalents)
english_language  English is the language of instruction at UBC ...
```

`advisory` separates the hard gates from `suggested_subjects` and
`recommended_grade_range`, which UBC offers as advice. `available: false` on
`by_location` means the program does not accept students from that curriculum at
all; 116 of the 2,520 combinations.

**`location_slug` is not unique on its own.** `basic`, the fallback UBC applies
when your province or country isn't listed separately, exists in _both_ the
province and the country list and means a different thing in each. Filter on
`(curriculum, location_slug)`, or on `location_term_id`, which is unique. It is
the only slug affected, which is what makes it easy to miss.

## Tuition and cost

`finances/tuition` is the authoritative rate table, melted long: one row per
(program, column) money cell, because UBC's fee tables run from one to eight
value columns and reshape from page to page. `student_type`, `cohort_year` and
`unit` are derived from the column header, the row label and the divider rows;
the raw `column`, `item` and `amount_text` sit next to them so any derivation
can be checked. Rows carrying no money (footnotes, eligibility conditions,
instalment counts) go to `fee_notes` instead of being dropped.

International undergraduate tuition freezes at the rate of your starting year,
which is why one program carries seven rates:

| program | student_type  | cohort_year | cohort_rule | unit       | amount  |
| ------- | ------------- | ----------- | ----------- | ---------- | ------- |
| Arts    | international | 2026        | or_later    | per_credit | 1717.68 |
| Arts    | international | 2025        | exactly     | per_credit | 1701.16 |
| Arts    | international | 2020        | or_earlier  | per_credit | 1544.63 |

`annual_at_30_credits` is the only arithmetic applied: the rate times a
full-time year, the load UBC's own estimator states its figures on.

`cost_estimates` is that estimator: UBC's first-year tuition, student fees, lab
fees and books for all 33 Vancouver program areas, with the totals added up.
`program_cost_estimates` attaches those to the 134 programs they price. Nothing
upstream links a program to an estimator area, so they are matched on names:
exactly on the program title or one of its degrees first, then on the area
sharing the most tokens with it, and only where that area is unique. Every row
records `matched_by`, and the 7 programs with no unique area (Journalism and
Architecture are graduate; "Bachelor of Education" spans two areas) are in
`_unmatched.json` instead of being given a wrong price.

## Learning spaces

`buildings.*` answers on its own: 50 buildings, each carrying the rooms
collected for it in floor order, largest first.

```json
{
  "Building Code": "BUCH",
  "Building Name": "Buchanan Building",
  "rooms_collected": 66,
  "formal_collected": 61,
  "informal_collected": 5,
  "total_capacity": 3407,
  "largest_room_capacity": 275,
  "floors": [1, 2, 3],
  "cover_photo_room": "BUCH A101",
  "rooms": [
    {
      "name": "BUCH A101",
      "room_number": "A101",
      "floor": 1,
      "capacity": 275,
      "space_type": "classroom",
      "room_link": "…/classrooms/buch-a101",
      "cover_photo_url": "…"
    }
  ]
}
```

Two derivations to know about:

- **Floor is derived.** Airtable has no floor field. Informal spaces usually say
  it in words ("B Block 2nd Floor Lounge"); classrooms encode it as the leading
  digit of the room number, behind an optional block letter: `BUCH B101` is
  Block B, room 101, floor 1, not a basement. `floor_source` says which route
  was taken. 350 of 411 rooms resolve; the rest are **left null instead of
  guessed**, because IRC numbers its rooms 1–6, G41–G66 and B75–B79 on a scheme
  of its own, FNH uses 30/40/50/60, and a wrong floor is worse to a student
  looking for a room than no floor.
- **Photo URLs expire.** UBC serves images from Airtable behind signed links
  that die within a day, and its own pages do the same; there is no stable URL
  to store. The images are not mirrored here, for the same reason the PDFs in
  `reports` aren't: this indexes what UBC publishes instead of rehosting it.
  `Room Link`, the durable route, re-renders a fresh URL on load;
  `cover_photo_expires` gives the deadline on the stored one and
  `cover_photo_id` outlives it, so a stale row reads as stale instead of
  broken. 409 of 411 rooms have a photo (`BUCH B202` and MCLD's catch-all row
  have none); each building takes its largest room's.

`buildings` holds 50 rows because the endpoint is asked per tab now. Asked only
once, it returned 38 rows and missed the 12 buildings that hold classrooms but
no informal space. Asked per tab, it returns all 50, and every room joins to
one.

## Campus

**This dataset is UBC Vancouver only.** That is the default and it is enforced
centrally: `src/base.ts` holds the selection, and every collector translates its
own campus marker (a `ubco/` directory, a `_O` course-code suffix, a `(UBC-O)`
term label, a `(Okanagan)` subject label, a campus relationship) into a name and
asks `wants()` before keeping a record.

```bash
npm run update                      # Vancouver only (default)
npm run update -- --campus okanagan # Okanagan only
npm run update -- --campus both     # everything
```

Switching is safe in both directions: after a collector succeeds, pruning
deletes the files it didn't write, so Vancouver-only removes the Okanagan files
and `both` restores them. The active setting is recorded as `campus` in
`data/manifest.json`.

| Group                             | How the filter applies                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `geospatial`                      | Keeps `ubcv/`, drops `ubco/`. `off-campus/` (UBC sites elsewhere in BC) is not campus-specific and is always kept.                                                                                                                                                                                                                                                         |
| `calendar`                        | Only the `vancouver.calendar.ubc.ca` host is fetched; `okanagan/` is not written.                                                                                                                                                                                                                                                                                          |
| `courses`                         | The API serves both campuses in one collection with **no campus field**, so a `campus` column is derived and then filtered on: course code `_V`/`_O`, term label `(UBC-V)`/`(UBC-O)`, subject label `(Vancouver)`/`(Okanagan)`, or a standard timetable's campus relationship. All 47,229 upstream courses resolve cleanly (38,529 V / 8,700 O); none are left unlabelled. |
| `admissions`                      | Programs reference campuses by term id; resolved against `campuses.json` (`9` = Vancouver, `10` = Okanagan). A program offered on both campuses is kept. Requirements are fetched per campus, as the endpoint takes one.                                                                                                                                                   |
| `finances`                        | Only the selected campus's calendar host is read for fee pages, and the cost estimator is keyed by campus already. `program_cost_estimates` reuses the `admissions` program filter, so the two stay in step.                                                                                                                                                               |
| `spaces`                          | Already Vancouver-only upstream: Find a Space accepts a campus parameter and ignores it.                                                                                                                                                                                                                                                                                   |
| `events`                          | No campus field exists upstream; events are not filtered. Venue `city` is the only proxy (189 Vancouver, 1 Kelowna).                                                                                                                                                                                                                                                       |
| `people` / `services` / `reports` | Organised by source site, not campus, and not filtered. PAIR publishes UBCO factsheets that remain in the document index.                                                                                                                                                                                                                                                  |

A record carrying **no** campus marker is always kept. Dropping unlabelled rows
would silently lose data if UBC changed a naming convention.

## File conventions

- Tabular datasets are written **twice**: `name.json` (full fidelity, nested
  values intact) and `name.csv` (same rows, nested values JSON-encoded into the
  cell). Use whichever suits your tooling.
- Files beginning with `_` are about the data rather than data itself:
  `_index`, `_source.json`, `_sources.json`, `_configs.json`, `_unavailable.json`.
- Geospatial files keep the upstream repository's directory layout
  (`ubcv/`, `ubco/`, `off-campus/`) so paths match UBC's own documentation, and
  each theme ships a `metadata/` CSV defining its fields.
- `data/catalog.json` is the table-level index: grain, columns and joins. Start
  there. `data/manifest.json` is the file-level one: every file, its record
  count, byte size, source URL and when it was last refreshed.

## Refreshing the data

```bash
npm install
npm run update
```

Running it refreshes the registered public groups under `data/`, regenerates `data/manifest.json`
with per-file record counts, sizes, sources and timestamps, and
`data/catalog.json` with the table-level index described above.

```bash
npm run update -- --list              # what's available
npm run update -- courses events      # refresh just these groups
npm run update -- --skip people       # everything except one group
npm run update -- --min-interval 300 # milliseconds between requests
npm run update -- housing libraries support policies # undergraduate collections
npm run validate:undergrad            # offline checks for structured facts
npm run collect:prose                # generate Markdown articles
npm run validate:prose               # prose safety, exports and inventory accounting
```

A group that fails is reported and recorded in the manifest, but the rest of the
run continues. Exit code is non-zero if anything failed.

Grade distributions (`data/grades/raw/`, UBCV Vancouver campus) are collected
from [ubc-pair-grade-data](https://github.com/DonneyF/ubc-pair-grade-data) by
the `grades` collector, which also derives `data/grades/distributions.json`.
Run `npm run update` or trigger the `Sync data` workflow.

## Sources

The institutional collections use public UBC endpoints: no credentials and no
scraping behind a login. The existing `grades` collector is an exception to direct
UBC sourcing: it uses a third-party mirror of aggregate distributions.
Undergraduate sources and their endpoints appear in
[UNDERGRADUATE-SOURCES.md](UNDERGRADUATE-SOURCES.md#official-sources-and-selection).
The additional Markdown source collections appear in [PROSE.md](PROSE.md#sources).

| Source                                                                                                                                                                            | Used for                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [UBCGeodata/ubc-geospatial-opendata](https://github.com/UBCGeodata/ubc-geospatial-opendata)                                                                                       | `geospatial`: pinned to the current commit SHA, recorded in `_source.json`                                                                                                                                                                                                   |
| [UBCGeodata/ubcv-parking](https://github.com/UBCGeodata/ubcv-parking)                                                                                                             | `geospatial`: parking facilities with rates, permits and payment links, mounted at `ubcv/parking/`. The location, building, route, landscape and context themes use `ubc-geospatial-opendata`; their standalone repositories have incomplete snapshots and are not mirrored. |
| [DonneyF/ubc-pair-grade-data](https://github.com/DonneyF/ubc-pair-grade-data)                                                                                                     | `grades`: raw per-subject CSVs mirrored under `raw/`, then derived into `distributions.json`                                                                                                                                                                                 |
| [courses.students.ubc.ca](https://courses.students.ubc.ca/) Drupal JSON:API                                                                                                       | `courses`                                                                                                                                                                                                                                                                    |
| [vancouver.calendar.ubc.ca](https://vancouver.calendar.ubc.ca/) / [okanagan.calendar.ubc.ca](https://okanagan.calendar.ubc.ca/) JSON:API                                          | `calendar`                                                                                                                                                                                                                                                                   |
| [learningspaces.ubc.ca Find a Space](https://learningspaces.ubc.ca/find-a-space/)                                                                                                 | `spaces`                                                                                                                                                                                                                                                                     |
| [events.ubc.ca](https://events.ubc.ca/resources/webdev/) Events Calendar REST API                                                                                                 | `events`                                                                                                                                                                                                                                                                     |
| [you.ubc.ca](https://you.ubc.ca/programs/) program finder + WP REST, and its `requirements_load_programs` AJAX action                                                             | `admissions`                                                                                                                                                                                                                                                                 |
| [vancouver.calendar.ubc.ca/fees](https://vancouver.calendar.ubc.ca/fees) tuition and fee tables, plus you.ubc.ca's cost estimator                                                 | `finances`                                                                                                                                                                                                                                                                   |
| UBC faculty/unit sites on the shared Drupal platform                                                                                                                              | `people`                                                                                                                                                                                                                                                                     |
| food.ubc.ca, parking.ubc.ca, facilities.ubc.ca, students.ubc.ca, recreation.ubc.ca, news.ubc.ca, [hr.ubc.ca statutory holidays](https://hr.ubc.ca/working-ubc/statutory-holidays) | `services`                                                                                                                                                                                                                                                                   |
| finance.ubc.ca, [pair.ubc.ca](https://pair.ubc.ca/) (Planning, Analytics & Institutional Research)                                                                                | `reports`                                                                                                                                                                                                                                                                    |

### Notes on a few of them

- **Course Schedule vs Academic Calendar.** The Course Schedule (`courses`) is
  what is _offered and when_. The Academic Calendar (`calendar`) is what a
  course _is_: description, prerequisites, credits. Join them on subject +
  course number.
- **Prerequisites live in prose.** The Academic Calendar schema _has_
  `field_course_prerequisite`, `field_course_co_requistite`,
  `field_course_vector` and `field_course_equivalency`, and all four are empty
  on every record sampled (0/350). UBC writes the whole lot into
  `field_course_description`, exactly as its own pages render it:

  > Physical and mathematical structures of computation. … sequential
  > instruction execution. **[3-2-1] Prerequisite:** Principles of Mathematics 12
  > or Pre-calculus 12. **Corequisite:** One of CPSC 107, CPSC 110.

  So `src/coursetext.ts` parses it back out into `prerequisite`,
  `corequisite`, `equivalency`, `credit_exclusion`, `hours_vector` and a cleaned
  `description_text`. These columns are **derived**: the original description is
  kept next to them so you can re-parse or spot-check. The same parser runs over
  the Course Schedule's `body` field, which carries prerequisite prose on about
  40% of courses.

- **The calendar is more than courses.** Degree and specialization requirements,
  faculty and school overviews, admission rules and academic regulations are all
  `node--ubc_page` records: a title, a path alias and a blob of body HTML, with
  no hierarchy attached. The alias _is_ the hierarchy, and it's what UBC renders
  its own breadcrumbs from:

  ```
  /faculties-colleges-and-schools/faculty-forestry-and-environmental-stewardship
    /bsc-degrees-students-who-started-prior-september-2024
      /bsf-bachelor-science-forestry/forest-resources-management-major
  ```

  So `src/calendarpages.ts` recovers ancestry by matching each alias prefix back
  to the page that owns it (real titles like "B.S.F. (Bachelor of Science in
  Forestry)", not de-slugified guesses), and derives `faculty`, `program`,
  `level` (undergraduate / masters / doctoral / certificate) and `kind`
  (`degree_requirements`, `major`, `minor`, `admission`, `regulations`…) from
  that chain plus the title. `referenced_courses` lists the course codes a page
  mentions, in the order it mentions them, validated against the campus's own
  subject vocabulary so "OR 100" doesn't read as a course. All derived, all next
  to the `body` and `alias` they came from.

- **Every Drupal record carries an `alias`.** It's the page's path on the site,
  and the one field that says where a record lives: `/courses/…`, `/profile/…`,
  a program's place in the calendar tree. Prefix it with the host for the public
  URL.
- **Deadline tables are transposed against each other.** On `dates.*`, the term
  tables run terms across the columns and events down the rows; the drop and
  withdrawal tables do the reverse. Only a term names a year, which is how the
  parser tells them apart, so `applies_to` and `event` mean the same thing in
  every row. Multi-week windows are kept rather than dropped: `span_days` is
  there to filter on if you only want single-day deadlines.
- **Statutory holidays use HTML.** UBC publishes them on hr.ubc.ca as a page,
  with no API behind it, so `src/collectors/holidays.ts` reads the tables through
  the dependency-free tokenizer in `src/htmldoc.ts`. The undergraduate housing
  and library collectors also read public HTML, using Cheerio for DOM selection
  and the shared text/table helpers for extraction.
- **Instructors sit on sections.** `courses/sections.json` has
  `field_instructors` populated on every row sampled, along with `field_days`,
  `field_start_time`/`field_end_time` and start/end dates. `courses/courses.json`
  has no instructor field; join sections to courses via `related.course`. Times
  are **seconds after midnight** (`55800` = 15:30).
- **One course node per offering-year.** `node/course` has ~47k rows because
  UBC creates an instance per course per academic year (`field_course_instance_id`),
  not ~12k unique courses. Deduplicate on `field_course_code` if you want the
  distinct course list.
- **Drupal JSON:API caps `page[limit]` at 50**, so the ~47k courses and ~44k
  sections take roughly 1,800 requests. The collector fans offsets out across
  threads when the server reports a total, and falls back to walking
  `links.next` when it doesn't.
- **Find a Space** is driven by a `data-config` blob on the page that mounts the
  app (`{"campus": ..., "formal": true}`). The collector discovers those configs
  by scanning the site's pages instead of hard-coding them, so an added campus
  or tab is picked up automatically. Its nonce is scraped fresh each run.
- **Institutional research is not an API.** UBC publishes budgets, financial
  statements and enrolment reports as PDF/CSV/XLSX attached to pages, so
  `reports` builds an _index_ of those documents with resolved download URLs
  instead of pretending there is structured data to fetch. What students
  pay is a different matter and _is_ structured; see `finances`.
- **Requirements cost 2,500 requests.** 20 requirement groups against 125
  locations, one POST each, which is most of what an `npm run update --
admissions` run spends its time on. Fetching per group rather than per
  program is what keeps it from being 15,000. The IB tab is free: unlike the
  province and country tabs it is rendered server-side, so it comes out of the
  page HTML.
- **Half the fee tables have no header row.** The graduate pages never open a
  `<th>`; the first rows are the program name, an instalment count, then the
  real header. `finances` finds it by looking for the row that fills the _value_
  columns rather than the label column: "Schedule | Domestic fee |
  International fee" fills two, while "Instalments per year | 3" fills one and
  is a fact about the program, not a header. Single-cell rows mid-table are
  dividers (`2026S or 2026W`) and label the rows beneath them.

## Adding a source

Drop a module in `src/collectors/` with a `register()`ed collector object, and
add it to the imports in `src/collectors/index.ts`:

```ts
import { register, type Http, type Output } from "../base.ts";

register(
  class {
    name = "housing"; // CLI name: npm run update -- housing
    folder = "housing"; // output dir: data/housing/
    title = "Student housing";
    description = "Residences, room types and rates.";
    sources = ["https://vancouver.housing.ubc.ca"];

    async collect(http: Http, out: Output): Promise<void> {
      const residences = await http.getJson("https://vancouver.housing.ubc.ca/…");
      out.describe("residences", {
        grain: "one residence",
        columns: { capacity: "beds", room_types: "what you can book" },
        joins: ["building -> geospatial/ubcv/locations building name"],
      });
      await out.table("residences", Array.isArray(residences) ? residences : []);
    }
  },
);
```

`src/base.ts` already provides the pieces you'll want: `Http` (retries,
backoff, throttling, a bounded `map` pool), `jsonapiCollection` and
`jsonapiIndex` for Drupal sites, `wpCollection` for WordPress sites,
`jsLiteral` for the sites that inline their dataset into a `var` on the page,
and `Output.table` / `.json` / `.csv` / `.raw` for writing. Anything written
through `Output` shows up in the manifest automatically.

`out.describe(...)` is optional but worth doing: it is what puts a table in
`catalog.json` with a grain and its joins, and a foreign key nobody wrote down
is the fastest way for a reader to misread this repo. Name the same stem you
pass to `table()`; both the JSON and the CSV pick it up. `columns` does not have
to be exhaustive: describe the ones that are not self-evident.

## Source provenance

Source URLs and timestamps identify each snapshot. Cite the official source page
and check its dates before using time-sensitive information. `--min-interval`
controls request spacing.
