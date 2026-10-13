# Collecting and maintaining data

The repository shares HTTP, DOM and serialization mechanics across structured
collectors, undergraduate prose and exact-host articles. Their scopes, output
formats and publication guarantees remain separate. See the
[consumer contracts](../QUERYING.md) and
[host publication contract](../HOST-DOCUMENTS.md).

## Architecture

| Path                          | Responsibility                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/core/`                   | HTTP, JSON/CSV serialization, output accounting, campus selection, collector registry and CMS clients |
| `src/core/response.ts`        | Response-byte reading and retryable status codes shared by `Http`, `ProseClient` and `HostRecording`  |
| `src/scraping/github.ts`      | Commit-pinned GitHub snapshots for grades and geospatial mirrors                                      |
| `src/scraping/ubc.ts`         | `hasUbcBranding` checks publisher branding separately from substantive homepage evidence              |
| `src/source-documents.ts`     | Shared source-document mapping, including `drupalDocument` used by structured collectors              |
| `src/collectors/`             | Structured source collectors; `index.ts` registers them for `src/update.ts`                           |
| `src/scraping/html.ts`        | Shared DOM/text primitives                                                                            |
| `src/prose/html.ts`           | `extractArticleFromDom` and shared article extraction                                                 |
| `src/prose/`                  | Prose source discovery, conversion, coverage and exports                                              |
| `src/host-crawl/scraper.ts`   | `defineHtmlHost` and `defineWordpressHost` snapshot/extraction wrappers                               |
| `src/host-crawl/discovery/`   | Host discovery helpers used by the collection pipeline                                                |
| `src/host-scrapers/policies/` | Source-specific discovery and exclusion evidence                                                      |
| `src/host-crawl/`             | Recording, replay, routing, validation and journaled publication                                      |
| `src/host-scrapers/`          | Specialized host definitions, generic-host declarations and saved routing policies                    |

The shared response reader leaves byte limits, retry budgets and failure
accounting to each caller; sharing it does not weaken host recording rules.

## Structured refresh

Use Node 24 or newer. Install locked dependencies with `npm ci`.

```sh
npm run update -- --list
npm run update
npm run update -- courses events
npm run update -- --skip people
npm run update -- housing libraries support policies --workers 3 --min-interval 300
npm run update -- bookings
npm run validate:undergrad
```

`--min-interval` is in milliseconds. A failed group records its error and retains
its prior manifest datasets; other groups continue, and the command exits
nonzero. Successful groups prune files they did not write. Housing, library,
support and policy collectors finish fetching before writing their tables.
The run rebuilds `data/catalog.json` and `data/manifest.json`.

`.github/workflows/sync.yml` is manually triggered and runs `npm run update`.
It does not collect prose or host documents. There is no automatic schedule.

### Campus selection

```sh
npm run update -- --campus vancouver
npm run update -- --campus okanagan
npm run update -- --campus both
```

Vancouver is the default. `src/core/campus.ts` supplies the shared selection;
collectors translate source markers before filtering. Successful pruning removes
unselected campus files. The manifest records the active selection.

| Group                     | Selection behavior                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| Geospatial                | Selects `ubcv/` or `ubco/`; retains non-campus-specific `off-campus/`                     |
| Calendar, finances        | Uses the selected calendar host; cost estimates also use campus-specific inputs           |
| Courses                   | Derives campus from `_V`/`_O` codes, term/subject labels or timetable relationships       |
| Admissions                | Resolves campus taxonomy IDs and fetches requirements per campus; retains shared programs |
| Learning spaces           | Upstream is Vancouver-only and ignores its campus parameter                               |
| Events                    | No upstream campus field; not filtered                                                    |
| People, services, reports | Source-site collections; not filtered by campus                                           |

Unlabelled records remain rather than being guessed or dropped. Undergraduate
source selection below has additional audience rules. Host admission uses its
own content-based campus review and [approved exceptions](../HOST-COVERAGE.md).

## Structured sources and extraction quirks

| Source                                                                                                                                      | Collection and constraints                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [UBC geospatial open data](https://github.com/UBCGeodata/ubc-geospatial-opendata) and [parking](https://github.com/UBCGeodata/ubcv-parking) | Pin upstream commit SHAs in `_source.json`; retain source layout. Standalone theme repositories can be incomplete. Record coordinate-header corrections without changing rows.                                     |
| [Aggregate grade mirror](https://github.com/DonneyF/ubc-pair-grade-data)                                                                    | Preserve raw subject CSVs and derive distributions; third-party historical data, not a current UBC feed.                                                                                                           |
| [Course schedule](https://courses.students.ubc.ca/)                                                                                         | Drupal JSON:API; one course node per offering year, instructors/times on sections. Page size caps at 50; fan out known offsets or follow `links.next`.                                                             |
| [Vancouver calendar](https://vancouver.calendar.ubc.ca/) and [Okanagan calendar](https://okanagan.calendar.ubc.ca/)                         | Parse course requirements from description prose because dedicated fields can be empty. Match alias prefixes to real page titles for ancestry. Deadline tables orient terms differently; retain multi-day windows. |
| [Find a Space](https://learningspaces.ubc.ca/find-a-space/)                                                                                 | Discover per-tab `data-config` and a fresh nonce. Fetching only one tab misses buildings. Retain source room labels; derive floors only for recognized schemes.                                                    |
| [Events](https://events.ubc.ca/resources/webdev/)                                                                                           | Events Calendar REST API and iCal; venue addresses do not establish coordinates.                                                                                                                                   |
| [Admissions](https://you.ubc.ca/programs/)                                                                                                  | Program finder, WordPress and `requirements_load_programs` AJAX. Fetch requirements per shared group and curriculum, not per program. IB requirements are server-rendered HTML.                                    |
| [Tuition](https://vancouver.calendar.ubc.ca/fees) and [program cost estimator](https://you.ubc.ca/programs/)                                | Fee headers vary; some tables have no `<th>`. Identify value-column headers, retain divider/cohort labels and non-money notes. Program-to-estimator matches are derived.                                           |
| Faculty/unit Drupal sites                                                                                                                   | Public profiles only where APIs exist; `_sites.json` records partial coverage.                                                                                                                                     |
| Food, parking, facilities, recreation, student-services and news sites                                                                      | Public source pages/APIs; preserve source-specific shapes and citation URLs.                                                                                                                                       |
| [Statutory holidays](https://hr.ubc.ca/working-ubc/statutory-holidays)                                                                      | Parse HTML tables, including UBC-specific holidays.                                                                                                                                                                |
| [Finance](https://finance.ubc.ca/) and [PAIR](https://pair.ubc.ca/)                                                                         | Index published PDF/CSV/XLSX URLs and their source pages, not invented structured report contents.                                                                                                                 |

The course parser retains original descriptions alongside derived fields.
`src/coursetext.ts` handles requirements; `src/calendarpages.ts` derives page
ancestry and course references; `src/htmldoc.ts` provides tokenizer/table helpers.
Cognitive-systems module rows come from the calendar collector's
`src/collectors/cogsmodules.ts` helper. Calendar term tables put terms in columns;
drop/withdrawal tables put them in rows. Year-bearing term labels distinguish
those layouts so `applies_to` and `event` retain the same meaning.

### Undergraduate source selection

Structured undergraduate groups publish facts and links, not copied article
bodies. Inclusion can cover shared graduate/staff resources and does not certify
an individual's eligibility.

**Housing:** use the [residence directory](https://vancouver.housing.ubc.ca/residences-rooms/residences/),
[residence sitemap](https://vancouver.housing.ubc.ca/wp-sitemap-posts-residences-1.xml),
[room sitemap](https://vancouver.housing.ubc.ca/wp-sitemap-posts-rooms-1.xml) and
[fee-parent API](https://vancouver.housing.ubc.ca/wp-json/wp/v2/pages?parent=48&per_page=100).
The general WordPress API contains empty placeholders; structured guidance uses
reviewed IDs recorded in `_source.json`, including
[First Year Guarantee](https://vancouver.housing.ubc.ca/applications/how-we-assign-rooms/first-year-guarantee/)
and [Important Dates](https://vancouver.housing.ubc.ca/applications/important-dates/).
Residence quick facts must explicitly mention undergraduates. Acadia Park's
omission under that rule does not establish undergraduate ineligibility for
family housing. Retain shared residences. Fee/room relationships follow official
links, normalizing trailing slashes and fragments, not titles or front-desk addresses.

**Libraries:** discover [hours and locations](https://hours.library.ubc.ca/) and
request [calendar rules](https://hours.library.ubc.ca/includes/calendar.inc.php)
with `location_id`, `year` and `month` as a read-only form request. Collect the
current Vancouver month and the next three; conflicting/unknown rules produce
`unknown`, not `closed`. The explicit
[booking-location](https://libcal.library.ubc.ca/spaces) crosswalk covers IKB,
Music/Art/Architecture, Koerner, Woodward and Research Commons. Keep `hours_id`
and `booking_lid` separate and preserve the Research Commons location discrepancy
documented in [the query guide](../QUERYING.md#buildings-housing-and-libraries).

**Student support:** [IT services](https://it.ubc.ca/jsonapi/node/service) require
Students in the [audience taxonomy](https://it.ubc.ca/jsonapi/taxonomy_term/audience).
[Wellbeing resources](https://wellbeing.ubc.ca/jsonapi/node/resources) require a
student audience and undergraduate/unspecified
[population](https://wellbeing.ubc.ca/jsonapi/taxonomy_term/student_population),
with campus filtering. Preserve literal `missing` taxonomy sentinels in
`_unavailable.json`; unknown ordinary IDs fail. Index
[Learning Commons](https://learningcommons.ubc.ca/wp-json/wp/v2/pages) separately
from its prose bodies.

**Policies:** select codes recorded in `_source.json` from the
[University Counsel index](https://universitycounsel.ubc.ca/policies) and
[policy metadata API](https://universitycounsel.ubc.ca/jsonapi/node/policy).
Coverage includes fees, aid, accessibility, safety, discrimination, travel and IT.
Metadata and listing status do not replace the binding document or certify its
current legal status.

### Housing TLS chain

An incomplete server chain can cause `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.
`NODE_EXTRA_CA_CERTS` can supply a verified issuing intermediate while retaining
root and hostname verification. Check that the issuer still matches the server's
current certificate before using this example:

```sh
work=$(mktemp -d)
curl --fail --location --max-time 30 \
  http://crt.sectigo.com/EntrustOVTLSIssuingECCCA2.crt \
  --output "$work/issuer.der" &&
openssl x509 -inform DER -in "$work/issuer.der" -out "$work/issuer.pem" &&
openssl verify -CApath /etc/ssl/certs "$work/issuer.pem" &&
NODE_EXTRA_CA_CERTS="$work/issuer.pem" \
  npm run update -- housing --workers 3 --min-interval 300
```

Do not disable TLS verification.

## Prose collection

Live sources are declared in `src/prose/sources.ts`; mirrored inventories are in
`src/prose/mirrors.ts`.

| Live subcategory       | Scope                                                         |
| ---------------------- | ------------------------------------------------------------- |
| `workday`              | Student tutorials                                             |
| `student-housing`      | Vancouver residences, rooms, application and housing guidance |
| `learning-technology`  | LTHub student guides                                          |
| `learning-commons`     | Study guidance                                                |
| `academic-integrity`   | Student/shared explanations, examples and FAQs                |
| `arts-advising`        | Arts programs and student guidance                            |
| `sauder-undergraduate` | myBCom handbook and articles                                  |
| `science-advising`     | Science resources and programs                                |
| `science-coop`         | Undergraduate/shared Science Co-op guidance                   |
| `go-global`            | Exchange, summer-abroad programs and FAQs                     |
| `library`              | Library Ask Us FAQs                                           |

Mirrors supply `academic-calendar`, `admissions`, `student-services`, `recreation`,
`campus-facilities`, `student-finances`, `it-services`, `wellbeing` and `policies`.
A missing mirrored body may use its public article page without changing the
structured source table or relabelling older snapshots as fresh.

Scope includes Vancouver/shared undergraduate content, graduation instructions
and shared eligibility guidance. Exclude personal profiles, student records,
graduate-only/staff-only material, authentication endpoints and binary downloads.
Historical guidance retains its source dates. No article-count or date cutoff applies.

```sh
npm run collect:prose -- --list
npm run collect:prose
npm run collect:prose -- workday student-housing
npm run collect:prose -- --skip sauder-undergraduate
npm run collect:prose -- --mirror-only --no-fill-missing
npm run collect:prose -- --refresh
npm run validate:prose
npm run validate:prose -- workday learning-technology
```

Defaults are three source workers and 500 ms between requests per origin, raised
to the site's crawl delay. myBCom requires ten seconds. Separate crawlers must not
contact the same host concurrently. Responses have a 25 MB limit and redirects a
hop limit; exceeding either produces an explicit error.

Private caches live under the external project workspace at
`state/source-prose/cache/`, not in Git. `UBC_TMP_ROOT` selects an absolute
external parent; the project workspace is its `ubc-unified-data` child. Cached
responses can be reused for 24 hours with their original retrieval timestamps;
`--refresh` requests new observations. See
[workspace constraints](../HOST-DOCUMENTS.md#private-acquisition-and-replay).

Validate WordPress totals, JSON:API cursors, identities and sitemap structure.
Drupal pagination continues through short or empty access-filtered batches;
omitted records are not fetched. Arts REST responses may prepend theme HTML to
JSON: accept only a fully parsed trailing array with matching header totals.
Resolve relative permalinks and unambiguous bare-host/email links before conversion.

HTML conversion sanitizes executable markup, event attributes, forms and unsafe
URLs, then validates Markdown tokens and destinations. Retain collapsed panels,
Drupal landing sections, myBCom text panes and admissions page-builder sections.
Keep the [article representation and coverage contract](../QUERYING.md#prose-article-contract).

## Add a collector or host

### Structured collector

Add a module under `src/collectors/`, register a class implementing `CollectorDescriptor` with
`register` from `src/core/registry.ts`, and import it once in
`src/collectors/index.ts`. Its `collect(http, out)` method uses `Http` from
`src/core/http.ts` and `Output` from `src/core/output.ts`. Import other shared
helpers from their owning modules: `src/core/campus.ts`, `src/core/drupal.ts`,
`src/core/serialization.ts`, `src/core/utils.ts` and `src/core/wordpress.ts`.
Source-document mappings belong in `src/source-documents.ts`, not in a collector
whose import registers unrelated sources.

Use `Output.table`, `.json`, `.csv` or `.raw` so the manifest accounts for output.
`out.describe(stem, { grain, columns, joins })` documents the same stem passed to
`table`; both JSON and CSV inherit that metadata. Preserve source fields beside
derivations and declare only joins supported by evidence.

### Specialized HTML host

Prefer the generic scraper for hosts that need no special extraction. Keep those
hostnames sorted and unique in `src/host-scrapers/generic-hosts.json`. Add a
specialized definition only for distinct boundaries, normalization or evidence.

The following template belongs in `src/host-scrapers/<hostname>/index.ts`.
`example.ubc.ca`, selectors and evidence text are placeholders: replace them with
observations from the reviewed homepage, not guessed endpoints or branding alone.

```ts
import { defineWordpressHost } from "../../host-crawl/scraper.ts";
import { hasUbcBranding } from "../../scraping/ubc.ts";

export const exampleScraper = defineWordpressHost({
  hostname: "example.ubc.ca",
  title: "Example UBC student service",
  scope: "Public student-service procedures and eligibility guidance.",
  selectors: ["#content > .hentry > .entry-content"],
  officialHomepage($, snapshot) {
    const guidance = $("#content .entry-content > p").text();
    return (
      hasUbcBranding($, snapshot.url, {
        homepage: "https://example.ubc.ca/",
        unit: "Example UBC student service",
      }) && /Students can request an appointment/.test(guidance)
    );
  },
});
```

`defineWordpressHost` declares page/post discovery, requires selectors and an
`officialHomepage` callback, checks exact-host homepage identity, and excludes
recognized multi-entry post indexes. Selectors are strict: a missing content
boundary must not fall back to site chrome. `defineHtmlHost` supports HTML-link
sites and optional `excludePage`, `validateSnapshot`, `extractPage` and
`normalizeArticle` hooks. Default extraction uses `extractArticleFromDom` on the
already parsed DOM. Specialized extraction must preserve source claims and links.

Import the definition into `src/host-crawl/registry.ts` and add it once to its
specialized registry. Do not also add it to the generic list or maintain a second
specialized-host list in the batch publisher. Registration is not admission:

1. Review the homepage for official identity and useful public article scope;
   honor explicit rejections, campus restrictions and access controls.
2. Save the reviewed routing policy under `src/host-scrapers/routing/`, including
   authority, rationale and source evidence. A missing policy blocks publication.
3. Add focused fixtures/tests for the content boundary, homepage evidence,
   exclusions and source-specific transformations. Generic hosts need no bespoke
   module or fixture solely for registration.
4. Acquire explicitly, replay without network fallback, validate complete output,
   then publish through the [host workflow](../HOST-DOCUMENTS.md#publication-and-verification).

## Verification

The portable Linux lane requires Node 24 or newer, Python 3, Poppler
(`pdftotext`) and util-linux (`prlimit`). Keep test temporary files in a private
external directory; CI prepares its own workspace and sets `UBC_TMP_ROOT` and
`TMPDIR`. Disable transpiler/runtime caches when testing byte-bound producer inputs.

```sh
npm ci
export TSX_DISABLE_CACHE=1 NODE_DISABLE_COMPILE_CACHE=1
npm run test:inventory
npm run test:portable -- --no-file-parallelism --maxWorkers=1
npx tsc --noEmit
npm run lint
npm run format:check
npm run validate:hosts -- --require-categories
npm run validate:prose
npm run validate:undergrad
```

Shared collector behavior has focused coverage in `src/core/collectors.test.ts`
and compatibility contracts in `src/core/contracts.test.ts`.

The validators check fields, citations, hashes, joins, export equality, counts
and sizes. Prose adds safe Markdown, standalone-body equality and inventory
accounting; host validation adds complete categorized roots and article quality.
Never format data or canonical routing policies to satisfy a style check.

### Native qualification

`npm test -- --no-file-parallelism --maxWorkers=1` runs the complete suite.
The named portable/native lanes partition it without changing assertions:

- `npm run test:portable -- --no-file-parallelism --maxWorkers=1` excludes fixed-profile
  native integration. GitHub CI runs this lane on Ubuntu and Node 24.
- `npm run test:native -- --no-file-parallelism --maxWorkers=1` runs
  `*.native.test.ts` on the reviewed CachyOS/Linux x86-64 profile with Node 26.8.1,
  matching ELF libraries and working unprivileged namespaces. Missing permissions,
  libraries or namespace support remain failures, not skips.
- `npm run test:inventory` checks that both selections are disjoint and together
  contain every default-suite test. It inventories tests; it does not execute or
  qualify the native runtime.

Native qualification must identify the exact release commit/tree, command,
result, test counts, dependency hashes and toolchain. Label local results as local,
not GitHub execution. Portable CI success does not qualify the native runtime.
Do not relax its ownership, loader, filesystem or process checks to accommodate
a different environment. Active article-only collection does not invoke the
retained native-Markdown runtime.
