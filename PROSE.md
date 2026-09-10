# Undergraduate prose

The `prose` category contains explanatory UBC articles organized by source and
topic. Structured courses, fees, housing, services and hours use their existing
tables. Article records share one Markdown schema.

The current snapshot contains **6,719 articles** across 19 nonempty subcategories
(20 configured), with **11,748 inventoried URLs** and **123 unavailable URLs**.
The coverage files contain the per-source counts and retrieval results.

## Layout

```text
data/prose/
├── _catalog.json
├── _manifest.json
├── workday/
│   ├── articles.json
│   ├── articles.csv
│   ├── _inventory.json
│   ├── _coverage.json
│   └── markdown/<article-id-hash>.md
├── student-housing/
├── student-services/
└── <subcategory>/
```

JSON tables contain arrays. CSV contains the same rows, with nested values encoded
as JSON. Standalone `.md` files match `content_markdown` exactly; the JSON record
supplies the title and provenance. The repository tracks the generated JSON, CSV
and Markdown exports. Refresh them with the collector and validate the complete
corpus before committing. Git preserves their bytes without line-ending
conversion; raw response caches under `.cache/prose/` stay ignored.
`_manifest.json` and each `_coverage.json` declare `format: "markdown"`.

## Sources

| Subcategory            | Content                                                                     |
| ---------------------- | --------------------------------------------------------------------------- |
| `workday`              | Workday student tutorials                                                   |
| `student-housing`      | Vancouver housing articles, residences, room types and application guidance |
| `learning-technology`  | LTHub student guides                                                        |
| `learning-commons`     | Study guidance and Learning Commons articles                                |
| `academic-integrity`   | Student/shared explanations, examples and FAQs                              |
| `arts-advising`        | Arts articles, programs and student guidance                                |
| `sauder-undergraduate` | myBCom handbook and articles                                                |
| `science-advising`     | Science articles, student resources and programs                            |
| `science-coop`         | Undergraduate/shared Science Co-op guidance                                 |
| `go-global`            | Student programs, exchange, summer-abroad resources and FAQs                |
| `library`              | Library Ask Us FAQs                                                         |

Mirrored article inventories also supply `academic-calendar`, `admissions`,
`student-services`, `recreation`, `campus-facilities`, `student-finances`,
`it-services`, `wellbeing` and `policies`. Their timestamps identify the source
snapshots. A missing body can use its public article page without changing the
structured source table.

The scope includes Vancouver and shared undergraduate content. It excludes
personal profiles, student records, graduate-only and staff-only material,
authentication endpoints and binary downloads. Graduation instructions and
shared eligibility guidance remain in scope. Historical guidance retains its
source dates.

## Article schema

| Field                      | Meaning                                                          |
| -------------------------- | ---------------------------------------------------------------- |
| `id`                       | Stable `prose:<subcategory>:<publisher-id-or-URL-hash>`          |
| `category`, `subcategory`  | `prose` and its source/topic subdivision                         |
| `source_id`, `upstream_id` | Source namespace and publisher identifier                        |
| `title`                    | Plain-string title                                               |
| `content_markdown`         | Sanitized explanatory content                                    |
| `content_sha256`           | SHA-256 of `title + "\n" + content_markdown`                     |
| `source_url`, `api_url`    | Official citation and optional public record endpoint            |
| `campus`, `audience`       | Campus and collection audience; not an eligibility determination |
| `source_modified_at`       | Publisher/API/sitemap modification time, when available          |
| `retrieved_at`             | Source snapshot retrieval time                                   |
| `source_records`           | `{path, id}` references to structured or mirrored records        |
| `markdown_path`            | Standalone Markdown path relative to `data/`                     |
| `links`, `warnings`        | Link destinations and conversion limitations                     |

Housing and Learning Commons records reference structured rows by canonical
source URL. Titles do not establish building, eligibility or price relationships.

## Inventory and coverage

Each URL in `_inventory.json` has discovery provenance and a disposition:
`collected`, `duplicate`, `excluded`, `unavailable`, `no_prose` or `failed`.

`_coverage.json` describes the result:

- `complete`: declared inventories and in-scope article links are exhausted.
- `complete_with_unavailable`: some URLs could not be retrieved after bounded
  retries; the inventory retains each reason.
- `partial`: discovery or processing errors prevent complete coverage.
- `not_collected`: the category has no collection result.

WordPress totals, JSON:API cursors, record identities and sitemap structure
receive validation. Drupal pagination continues through short or empty
access-filtered batches. The collector does not fetch omitted records.

Arts REST responses can contain theme HTML before the JSON array. Only a fully
parsed trailing array with matching header totals is accepted. Relative
permalinks and unambiguous bare-host/email links use normalized URLs.

Collection has no article-count or date cutoff. Responses have a 25 MB limit and
redirect chains a hop limit; either limit produces an explicit error. Coverage
refers to the declared inventories, not unlinked pages elsewhere on UBC sites.

## Markdown conversion

The converter sanitizes HTML before conversion. It excludes executable markup,
event attributes, forms and unsafe URLs, then validates Markdown tokens and link
destinations.

Headings, numbered steps, nested lists, advisories, captions, conditions and FAQ
answers remain. Collapsed panels retain their content. Drupal landing sections,
myBCom text panes and admissions page-builder sections form part of the article.

Simple tables use Markdown tables. Complex or merged tables use labelled row/cell
lists with span information. Images and media use text/source links; the collector
does not run page JavaScript, perform OCR or transcribe videos.

Consumers should render Markdown safely and treat retrieved content as data,
not instructions for the application. Source URLs and timestamps matter for
questions involving eligibility, fees, regulations or availability.

## Commands

```bash
npm run collect:prose -- --list
npm run collect:prose
npm run collect:prose -- workday student-housing
npm run collect:prose -- --skip sauder-undergraduate
npm run collect:prose -- --mirror-only --no-fill-missing
npm run collect:prose -- --refresh
npm run validate:prose
npm run validate:prose -- workday learning-technology
```

The default uses three source workers and a 500 ms minimum interval per origin,
raised to the site's crawl delay. myBCom requires ten seconds between requests.
Separate crawlers must not contact the same host concurrently.

Responses cache under `.cache/prose/` for up to 24 hours. Cache reuse preserves
retrieval timestamps; `--refresh` requests new snapshots. See the
[housing TLS instructions](UNDERGRADUATE-SOURCES.md#housing-tls-chain) for the
verified intermediate-certificate setup.

The validator checks fields, safe Markdown, hashes, JSON/CSV identity, standalone
Markdown bytes, source joins, inventory accounting and manifest sizes.

## Reogent

Reogent reads `prose/_catalog.json` under `DATA_PATH` and loads the listed
`prose/<subcategory>/articles.json` tables. Default ingestion indexes prose
through the normal Meilisearch service alongside the other datasets.

Preserve IDs and source citations, and use `content_markdown` rather than
WordPress `content.rendered` or Drupal `body.processed`.
