# Undergraduate sources

These collections serve UBC Vancouver undergraduates and include shared student
resources. Structured tables contain facts and source-link indexes; explanatory
articles use the common schema under `data/prose/<subcategory>/`.
[PROSE.md](PROSE.md) documents article collection, fields and coverage.

A resource can also serve graduate students or staff. Inclusion does not establish
an individual's eligibility. Source dates and qualifications remain important.

## Structured coverage

The September 10, 2026 snapshot contains **2,114 JSON rows across 18 tables**,
counting each JSON/CSV pair once. Housing fee observations include **513 monetary
amounts**, with null values for source blanks and dashes.

| Group             | Tables                                                         | Coverage                                                                     |
| ----------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `housing`         | `residences`, `room_types`                                     | 14 undergraduate-serving residences and 12 room types                        |
| `housing`         | `fee_pages`, `fee_tables`, `guidance`                          | 16 fee-source entries, 22 fee tables and 20 guidance links                   |
| `libraries`       | `branches`, `monthly_schedules`, `hours`                       | 15 physical/virtual service locations, 60 schedules and 1,830 dated records  |
| `student-support` | `it_services`, `wellbeing_resources`, `learning_commons_pages` | 19 IT services, 5 wellbeing resources and 34 Learning Commons source entries |
| `student-support` | Audience, campus, category and population tables               | 50 taxonomy definitions                                                      |
| `policies`        | `index`                                                        | 17 policy identifiers, dates and canonical source links                      |

`data/catalog.json` describes tables and joins. `_source.json` and `_sources.json`
contain authority, scope, timestamps and source-specific qualifications.
`representation: "facts_and_links"` identifies their structured content.

## Official sources and selection

### Student Housing and Community Services

- [Residence directory](https://vancouver.housing.ubc.ca/residences-rooms/residences/)
- [Residence sitemap](https://vancouver.housing.ubc.ca/wp-sitemap-posts-residences-1.xml)
- [Room-type sitemap](https://vancouver.housing.ubc.ca/wp-sitemap-posts-rooms-1.xml)
- [Fee collection](https://vancouver.housing.ubc.ca/wp-json/wp/v2/pages?parent=48&per_page=100)
- [First Year Guarantee](https://vancouver.housing.ubc.ca/applications/how-we-assign-rooms/first-year-guarantee/)
- [Important Dates](https://vancouver.housing.ubc.ca/applications/important-dates/)

Residence and room pages use sitemap discovery. The structured fee and guidance
indexes use the WordPress pages API. The general API contains empty placeholders;
the structured collector uses the fee parent and the guidance IDs in `_source.json`.
The prose collector covers the broader article inventory.

Residence quick facts must explicitly mention an undergraduate audience for the
structured residence table. Acadia Park's quick facts do not meet that criterion;
this does not imply that undergraduates are ineligible for family housing. Shared
undergraduate/graduate residences remain in scope.

`fee_page_ids` and room relationships follow official links. URL matching
normalizes trailing slashes and fragments. Front-desk locations are not assumed
to identify residence-building coordinates.

### UBC Library

- [Library home](https://www.library.ubc.ca/)
- [Hours and locations](https://hours.library.ubc.ca/)
- [Calendar endpoint](https://hours.library.ubc.ca/includes/calendar.inc.php)
- [Booking locations](https://libcal.library.ubc.ca/spaces)
- [Ask Us](https://answers.library.ubc.ca/askus)

The calendar endpoint accepts `location_id`, `year` and `month` as a read-only
form request. Collection covers the current Vancouver month and the following
three months. Regular, holiday, exception and exam rules determine each date.
Unknown or conflicting rules produce `unknown`, not `closed`.

`hours_id` and `booking_lid` are separate namespaces. The explicit crosswalk covers
IKB, Music/Art/Architecture, Koerner, Woodward and Research Commons. `booking_lid`
is a string matching `room-bookings/locations.lid`.

Research Commons has a Koerner floors 4–5 address in the hours source, while the
booking snapshot assigns `IBLC`. Verify its location before combining those
sources for navigation; the name alone does not establish a building join.

### Student support

- [IT services](https://it.ubc.ca/jsonapi/node/service)
- [IT audiences](https://it.ubc.ca/jsonapi/taxonomy_term/audience)
- [Wellbeing resources](https://wellbeing.ubc.ca/jsonapi/node/resources)
- [Wellbeing populations](https://wellbeing.ubc.ca/jsonapi/taxonomy_term/student_population)
- [Learning Commons](https://learningcommons.ubc.ca/wp-json/wp/v2/pages)

IT records require Students in their audience taxonomy. Wellbeing records require
a student audience and undergraduate or unspecified population, with campus
filtering. Descriptions and guidance use the corresponding prose articles.

Drupal's literal `missing` relationship target has no available taxonomy label.
`_unavailable.json` identifies affected records. Missing labels are not inferred;
an unresolved ordinary UUID causes validation to fail.

### University Counsel

- [Policy index](https://universitycounsel.ubc.ca/policies)
- [Policy metadata](https://universitycounsel.ubc.ca/jsonapi/node/policy)

The selected codes in `_source.json` cover fees, financial aid, accessibility,
safety, discrimination, travel and IT. Shared policies can apply beyond
undergraduates. `content_kind: "policy_index"` identifies metadata rather than the
binding document. `lifecycle: "listed"` does not certify current legal status.

## Fields and qualifications

Common fields include `id`, `source_url`, `retrieved_at` and `record_sha256`.
Source indexes also expose `source_id`, `title`, `api_url` and
`source_modified_at` where available. The record hash excludes retrieval time
and the hash field itself.

### Housing fees

Each `housing/fee_tables.values` observation contains source row/column positions,
row and column labels, contract/date labels, `amount_text`, exact integer
`amount_cents`, an optional per-person basis and footnote markers.

Null means a source blank or dash, not zero. `source_context_required: true`
requires consulting the full conditions. The prose articles preserve those
explanations and reference structured rows. Do not assume every rate is
undergraduate-eligible, multiply monthly instalments by twelve or add instalments
to a contract total that already includes them.

### Library hours

`status: "open"` describes scheduled hours for a date, not current occupancy.
`HH:mm` uses `America/Vancouver` wall time. `closes_next_day` distinguishes an
overnight closing from a same-day interval. Dates outside the snapshot are
unknown. `additional_hours_urls` identifies separate service-hour sources.

## Refresh and verification

```bash
npm ci
npm run update -- support policies housing libraries --workers 3 --min-interval 300
npm run validate:undergrad
npm run collect:prose
npm run validate:prose
npm test
npm run lint
npx tsc --noEmit
npm run format:check
```

`--min-interval` is in milliseconds. Structured collectors finish fetching before
writing tables. The validators check fields, hashes, citations, joins, counts,
JSON/CSV equality and file sizes. Prose validation also checks safe Markdown,
standalone body files and inventory accounting.

### Housing TLS chain

An incomplete server certificate chain can produce
`UNABLE_TO_VERIFY_LEAF_SIGNATURE`. `NODE_EXTRA_CA_CERTS` can supply a verified
issuing intermediate while preserving root and hostname verification.

```bash
work=$(mktemp -d)
curl --fail --location --max-time 30 \
  http://crt.sectigo.com/EntrustOVTLSIssuingECCCA2.crt \
  --output "$work/issuer.der" &&
openssl x509 -inform DER -in "$work/issuer.der" -out "$work/issuer.pem" &&
openssl verify -CApath /etc/ssl/certs "$work/issuer.pem" &&
NODE_EXTRA_CA_CERTS="$work/issuer.pem" \
  npm run update -- housing --workers 3 --min-interval 300
```

The issuer must match the server's current certificate chain. Do not disable TLS
verification.

## Reogent integration

Reogent registers JSON inputs explicitly. Structured adapters use the fact tables;
prose adapters use plain `title` and `content_markdown` from the article tables
under `DATA_PATH/prose`. Stable IDs, source URLs, timestamps and `source_records` support
upserts, citations and cross-references.

The prose catalog supplies subcategory tables for default ingestion into the
normal Meilisearch service. Rolling library hours require expiry/replacement
because upserts alone do not remove absent records. Derived artifacts require a
writable output path.
