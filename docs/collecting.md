# Collecting and maintaining data

Use Node 24+ and `npm ci`. See [consumer contracts](querying.md) and the
[host workflow](hosts.md). Find sources in the [collector registry](../src/collectors/index.ts),
[prose sources](../src/prose/sources.ts) and [mirrors](../src/prose/mirrors.ts);
find published tables/articles in the [structured](../data/catalog.json) and
[prose](../data/prose/_catalog.json) catalogs.

## Structured refresh

```sh
npm run update -- --list
npm run update
npm run update -- courses events
npm run update -- --skip people
npm run update -- housing libraries support policies --workers 3 --min-interval 300
npm run update -- bookings
npm run validate:undergrad
```

Defaults: `--workers 8`, `--timeout 60` seconds, `--min-interval 0` milliseconds.
Repeat `--skip` to omit groups. Failed groups retain prior manifest datasets;
other groups continue, then the command exits nonzero. Successful groups prune
unwritten files. Housing, libraries, support and policies fetch before writing.
Each run rebuilds `data/catalog.json` and `data/manifest.json`.
The manual [sync workflow](../.github/workflows/sync.yml) runs structured refreshes;
it has no schedule and excludes prose/host collection.

### Campus selection

Use `--campus vancouver` (default), `--campus okanagan` or `--campus both`.
Successful pruning removes unselected campus files; the manifest records selection.
Keep unlabelled records rather than guessing their campus.

- Geospatial: select `ubcv/` or `ubco/`; retain `off-campus/`.
- Calendar/finances: select calendar hosts and campus-specific cost inputs.
- Courses: use `_V`/`_O`, term/subject labels or timetable relationships.
- Admissions: resolve campus taxonomy IDs and requirements; retain shared programs.
- Learning spaces: Vancouver-only upstream ignores its campus parameter.
- Events have no campus field. People, services and reports use source-site scope.

Apply undergraduate audience rules below. Review host campus scope and exceptions
under [admission and scope](hosts.md#admission-and-scope).

## Source quirks

- Pin GitHub mirrors to commit SHAs in `_source.json`. Preserve geospatial layouts
  and rows; record coordinate-header corrections. Standalone theme repositories
  can omit data. Preserve raw grade CSVs and source dates from the third-party mirror.
- Course nodes represent offering years; sections hold instructors/times.
  Drupal caps pages at 50. Structured `jsonapiCollection` fans out known offsets
  or follows `links.next`; its cursor fallback stops at an empty batch.
  `drupalRecords` rejects empty intermediate pages and checks totals/identities.
- Calendar: retain descriptions beside parsed requirements; dedicated fields can
  be empty. Match alias prefixes to page titles for ancestry. Term tables use
  columns; drop/withdrawal tables use rows. Use year-bearing labels to preserve
  `applies_to`/`event` orientation and multi-day windows. Retain UBC-specific holidays.
- Learning spaces: discover each tab's `data-config` and fresh nonce. Retain room
  labels; derive floors from recognized schemes. Event venue addresses are not coordinates.
- Admissions: fetch requirements per shared group/curriculum; IB uses rendered HTML.
  Tuition tables can lack `<th>`: retain value headers, cohort/divider labels and
  non-money notes. Treat estimator matches as derivations.
- People APIs provide partial public-profile coverage (`_sites.json`). Index
  report PDF/CSV/XLSX links with source pages; do not invent report contents.

### Undergraduate source selection

Publish structured facts and links, including qualifying shared graduate/staff
resources; inclusion does not establish eligibility.

- **Housing:** use residence/room sitemaps, the directory and fee pages under parent
  `48`. General WordPress pages include empty placeholders; use reviewed guidance
  IDs in `_source.json`. Require quick facts that mention undergraduates; retain shared
  residences. Acadia Park's omission does not establish family-housing ineligibility.
  Join fees/rooms through official links, normalizing slashes/fragments, not titles
  or front-desk addresses.
- **Libraries:** request `calendar.inc.php` with `location_id`, `year`, `month` as
  a read-only form request. Collect the current America/Vancouver month plus three.
  Conflicting/unknown rules mean `unknown`, not `closed`. Keep `hours_id` and
  `booking_lid` separate; use the reviewed crosswalk and retain the
  [Research Commons discrepancy](querying.md#buildings-housing-and-libraries).
- **Support:** require Students in IT's audience taxonomy; Wellbeing needs student
  audience, undergraduate/unspecified population and campus filtering. Preserve
  literal `missing` sentinels in `_unavailable.json`; fail on unknown ordinary IDs.
  Keep Learning Commons' link index separate from prose.
- **Policies:** select `_source.json` codes from Counsel's index/API. Consult binding
  documents for legal status; listing metadata cannot establish it.

### Housing TLS chain

For `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, supply a verified issuing intermediate with
`NODE_EXTRA_CA_CERTS`. Check the current server certificate's issuer before using
this example; retain root and hostname verification.

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

Do not disable certificate checks.

## Prose collection

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

Defaults: `--workers 3` (allowed: 1–8), `--timeout 30` seconds,
`--min-interval 500` milliseconds per origin, raised to robots crawl delay.
Allow ten seconds for myBCom; do not run simultaneous crawlers against one host.
Limits: 25 MB per response, ten visited URLs per redirect chain. Violations fail.

Keep private caches at `$UBC_TMP_ROOT/ubc-unified-data/state/source-prose/cache/`.
Use an absolute external parent without symlinks; the default parent is
`$HOME/Projects/ubc-tmp`. Reuse lasts 24 hours and retains retrieval timestamps;
`--refresh` requests new observations. See [workspace rules](hosts.md#private-acquisition-and-replay).
Missing mirror bodies can use public pages unless `--no-fill-missing`; preserve
structured tables and original snapshot dates.

Collect Vancouver/shared undergraduate guidance, including graduation and shared
eligibility. Exclude profiles, student records, graduate/staff-only pages, auth
endpoints and binaries. Retain source dates; apply no article-count or date cutoff.

Validate WordPress totals, JSON:API cursors/identities and sitemaps. Prose Drupal
pagination follows advancing cursors through short/empty permission-filtered
batches without fetching omitted records. Arts theme-prefixed REST output requires
a complete trailing JSON array matching header totals.

Resolve relative and unambiguous bare-host/email links. Sanitize executable markup,
event attributes, forms and unsafe URLs; validate Markdown tokens/destinations.
Retain collapsed panels, Drupal landing sections, myBCom panes and admissions
page-builder sections. Follow the [article contract](querying.md#prose-article-contract).

## Add a collector or host

### Structured collector

Implement a `CollectorDescriptor` class in `src/collectors/`, call `register` from
`src/core/registry.ts`, and import the module once in `src/collectors/index.ts`.
Use `collect(http, out)` with `Http` and `Output` from `src/core/`.
Import shared mechanics from `src/core/`, CMS/DOM helpers from `src/scraping/`,
and document shaping from `src/source-documents.ts`; importing another collector
can register unrelated sources. Use `scraping/javascript.ts` for inline datasets
without executing publisher scripts.

Write through `Output.table`, `.json`, `.csv` or `.raw` for manifest accounting.
Call `out.describe(stem, { grain, columns, joins })` with the table's stem for both
exports. Preserve source fields beside derivations; require evidence for joins.

### Specialized HTML host

Use `src/host-scrapers/generic-hosts.json` for hosts without special extraction;
keep it sorted and unique. For distinct boundaries, normalization or evidence,
add `src/host-scrapers/<hostname>/index.ts`; use the
[BMLSc definition](../src/host-scrapers/bmlscpathology.med.ubc.ca/index.ts) as a model.

Use wrappers from `src/host-crawl/scraper.ts`.
`defineWordpressHost` requires selectors and `officialHomepage`, checks exact-host
identity, discovers pages/posts and excludes recognized post indexes. Require
substantive homepage evidence beyond branding. Missing selectors must fail rather
than fall back to chrome. `defineHtmlHost` supports HTML-link discovery and
`excludePage`, `validateSnapshot`, `extractPage`, `normalizeArticle` hooks.
Preserve claims/links under the [text contract](hosts.md#text-and-provenance).
Use `pageUrlPolicy`/`urlExclusion` from `src/host-crawl/urls.ts`; `excludeUrl` returns
`null` or `{ code, reason }`. Branch on stable codes, not diagnostic text.

1. Register once in `src/host-crawl/registry.ts`; omit specialized hosts from the
   generic list. Do not duplicate the registry in the batch publisher.
2. Review official identity, public article scope, campus restrictions, rejections
   and access controls. Save authority, rationale and source evidence in
   `src/host-scrapers/routing/`. Registration grants no admission; missing policy
   blocks publication. Keep source discovery/exclusion evidence in
   `src/host-scrapers/policies/`.
3. Test content boundaries, homepage evidence, exclusions and transformations.
   Generic registration alone needs no bespoke module/fixture.
4. Acquire, replay without network fallback, validate complete output and
   [publish through the host workflow](hosts.md#publication-and-verification).
   `BatchPublisher` owns reviewed Git targets, staging, commits and push receipts;
   keep publication separate from collection and admission.

## Verification

Portable Linux prerequisites: Node 24+, Python 3, Poppler (`pdftotext`), util-linux
(`prlimit`). Use a private external workspace without symlinks. Freeze source and
package inputs during producer-sensitive tests; disable runtime/transpiler caches.

```sh
UBC_TMP_ROOT=$(mktemp -d "$HOME/ubc-check.XXXXXX") || exit 1
export UBC_TMP_ROOT
export TMPDIR="$UBC_TMP_ROOT/tmp"
install -d -m 700 "$TMPDIR"
export TSX_DISABLE_CACHE=1 NODE_DISABLE_COMPILE_CACHE=1
npm ci
npm run test:inventory
npm run test:portable -- --no-file-parallelism --maxWorkers=1
npx tsc --noEmit
npm run lint
npm run format:check
npm run validate:hosts -- --require-categories
npm run validate:prose
npm run validate:undergrad
```

Validate citations, hashes, joins, export equality, counts/sizes, safe Markdown,
body equality, inventory accounting and complete categorized host roots/article
quality. Do not format data or canonical routing policies to satisfy style checks.

### Native qualification

`npm test -- --no-file-parallelism --maxWorkers=1` runs both lanes.
`test:inventory` checks their disjoint, complete selection; it executes no tests.
GitHub CI runs `test:portable` on Ubuntu/Node 24, excluding `*.native.test.ts`.

Run `npm run test:native -- --no-file-parallelism --maxWorkers=1` on the reviewed
CachyOS/Linux x86-64 profile: Node 26.8.1, matching ELF libraries and working
unprivileged namespaces. Missing permissions/libraries/namespaces are failures,
not skips. Do not weaken ownership, loader, filesystem or process checks.
Synthetic test handles cannot authorize the public native runtime.

Report the release commit/tree, command, result, counts, dependency hashes and
toolchain; distinguish local execution from GitHub. Portable success does not
qualify native execution. Article-only collection does not invoke the native
Markdown runtime.
