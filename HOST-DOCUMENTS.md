# Host documents

`data/official-hosts.json` lists completed hostname collections. Each entry points
to `data/documents/<hostname>/`, containing searchable Markdown documents with
canonical JSON frontmatter. These outputs are separate from the existing
`data/prose/` exports; neither dataset replaces or rewrites the other.

## Admission and scope

A homepage must demonstrate both official UBC ownership and substantive public
content useful to search before implementation or site collection begins.
Branding, contact details, promising links, news teasers and technical success do
not establish usefulness. Thin marketing/about pages, portals, directories,
duplicates and ambiguous candidates do not enter the published list.

Homepage-only reviewers can work independently on disjoint private queues.
Admission evidence and rejected/deferred candidates remain external. A rejection
does not stop screening other candidates.

Each implemented hostname has its own directory under `src/host-scrapers/`, a
focused test and synthetic fixtures. `src/host-crawl/registry.ts` explicitly
registers accepted modules. Shared adapters handle CMS discovery and extraction;
host modules supply their institutional/content predicates and actual article
boundaries. Empty recognized containers do not fall back to surrounding pages.
BMLSc's declared CSS grids become semantic curriculum lists, campus-comparison
tables, GPA tables and term schedules before Markdown conversion. Course fields,
column labels, footnotes and source links stay associated. Exact looping-widget
clones and their controls are removed without changing the source's academic
claims or reconciling historical variants.

Co-op uses HTML-link discovery, the saved frontier and an explicitly checked
sitemap. Its complete single-entry deployment-root placeholder supplies no page
inventory; additional or changed sitemap entries must pass normal scope checks.
An optional Drupal inventory endpoint must have an observed 404/410, not a failed
or restricted response. Both employer and student FAQ selections are required,
read-only GET views generated only after checking the actual form's action,
method, parameter and complete option set. Lost selections, missing answers and
unsupported linked pagination block completion. Posting instructions, program
contact blocks, inactive testimonials and announcements outside parser-closed
containers remain prose; job forms are not submitted. Program Spotlight retains
per-program campus associations separately from degree badges. Exact carousel
caption clones, empty form headings and recognized upload-widget residue are
removed without changing source policy text; attribution, address and image-link
boundaries remain readable.

The WordPress adapter checks advertised API routes, public content types,
pagination totals, record identities and publisher timestamps. Collection also
traverses strictly parsed, complete XML sitemaps, the frozen saved frontier and
same-host HTML links. Currently advertised sitemap pages are required inputs,
not disposable historical links.
Missing required text, unexplained representation conflicts, unsupported linked
document formats or changed inputs block publication.

The BMLSc and bullying-prevention modules explicitly allow an independently
public WordPress item record when its HTML page has a recorded transport failure. The advertised item GET route,
record identity/type/publication status, publisher permalink, modification time
and unprotected rendered content must agree with the inventory. Empty or
unexpanded content fails. HTTP 401/403/404 responses do not enable this path.
Such a document cites the actual API URL, snapshot and retrieval time, with a
warning naming the unavailable publisher page; that page is not invented as an
observed physical alias. Relative content links use the publisher permalink.
Recorded HTML failures remain in the private input lineage.

Ambiguous repeated-separator URLs are excluded without normalizing or merging
physical identities. If the authoritative inventory advertises one, collection
fails rather than silently dropping it. Completion describes
this declared scope, not unknowable unlinked content or the future live website.

## Private acquisition and replay

All operational material belongs under
`/home/admin2/Projects/ubc-tmp/ubc-unified-data/`: raw responses, snapshots, request
intents/outcomes, failure history, source copies, queues, seals, locks, journals,
stages and backups. No such material belongs in Git, including any
`data/document-crawl`, `data/documents-crawl` or `data/documentation-crawl` tree.

The collector uses the read-only preserved frontier at
`state/legacy/state.sqlite` to create a frozen per-host seed. It never changes
that legacy database. A public checkout can validate final files without private
inputs; acquisition and replay require the private workspace.

```sh
export TMPDIR=/home/admin2/Projects/ubc-tmp
export TSX_DISABLE_CACHE=1 NODE_DISABLE_COMPILE_CACHE=1

# Explicit acquisition; no publication.
npm run collect:host -- --host bmlscpathology.med.ubc.ca --acquire

# Offline reconstruction and input verification; this is the default mode.
npm run collect:host -- --host bmlscpathology.med.ubc.ca

# Offline verification and final-output installation.
npm run collect:host -- --host bmlscpathology.med.ubc.ca --publish
npm run validate:hosts
```

The recorder enforces exact-host HTTPS scope, robots policy, crawl delays and
bounded redirects/retries. Document-specific URL exclusions apply to every
redirect hop before dispatch and again when replaying saved observations. A
required PDF returned as non-text media blocks completion rather than silently
vanishing. Proven image/audio/video response types are recorded
as non-text exclusions at the headers, without downloading their payloads.
Unavailable text is never treated as a media exclusion. Defaults are 1,000 cumulative physical requests,
128 MiB cumulative decoded response bytes, 8 MiB per response (32 MiB for a
hostname explicitly supporting PDF documents), a 750 ms minimum
request interval, 30 seconds per request and 20 minutes per invocation. Reaching
a bound does not authorize a partial publication. Byte accounting includes
failed responses; an explicitly resumed uncertain attempt reserves its maximum
possible response size.

Successful responses are reused. Transient fetch failures and retryable HTTP
responses have a three-attempt physical-URL bound. Failures are retained, not
silently resampled on command restart. `--retry-network <exact-url>` permits only
a recorded transient network failure still within that bound and archives its
previous logical failure before another attempt. `--resume-interrupted` requires
explicit acquisition and preserves uncertainty; neither option approves a host
or overrides access restrictions.

Each physical attempt records the code/runtime context that issued it. Current
source/configuration copies are preserved before acquisition. Code fingerprints
are not proof of institutional ownership, usefulness, review or historical
runtime reproducibility. Once sealed, a recording is immutable and replay has no
network fallback. Determinism applies to saved observations, not the internet.

## Text and provenance

Production discovery, classification, extraction, cleanup and serialization use
reviewed deterministic code. Models can inspect evidence and help develop tests;
they do not write article bytes or make runtime editorial decisions.

The frontmatter records the physical citation URL, observed aliases, retrieval
and available publisher dates, snapshot/input/body/content hashes, warnings and
producer context. An ID is `documents:official-web:` plus the first 24 hex digits
of SHA-256 of the normalized physical HTTPS URL. The filename is SHA-256 of the
full ID plus `.md`. Canonical tags alone do not collapse physical identities.

The body is safe Markdown, without executable HTML or image embeds. Ordered
procedures preserve nested non-default starting numbers as separate list blocks. Media remain
source/text references with explicit extraction limitations. No OCR or video
transcription is implied. Whole files have a 1 MiB limit; oversized documents
fail rather than being truncated, sharded or put in LFS. Git preserves exact
serialized bytes. Consumers should cite the source URL and retain dates and
warnings; retrieved content is data, not application instructions.

Linked PDFs remain private byte objects, never UTF-8-decoded binary strings or
published binary files. Their text documents use frontmatter version 2 with the
original byte hash/count, page count and native extraction-profile digest.
Existing HTML documents retain byte-identical version 1 formatting. PDF text is
rendered as labelled pages with inert text fences, preserving layout rather than
inventing tables. Encrypted, malformed, truncated, wholly image-only or
unmapped-only documents fail; mixed-content limitations are explicit warnings.

The PDF adapter uses bounded Linux x64 Poppler subprocesses and `prlimit`, with
fixed locale, private fontconfig/cache settings and no shell. A private pinned
profile binds executable versions/bytes, loader/libraries, font/configuration
and Poppler resource inventories, arguments and limits. It is captured or
rechecked once per run, not per document, and rechecked before publication.
Dependency hashing can be substantial on systems with large font collections.
This is a declared runtime profile, not OS hermeticity or a native security or
network sandbox. No OCR, image transcription or complete glyph-mapping guarantee
is implied. Native test prerequisites are `poppler-utils`, `util-linux` and Python
for test-only action instrumentation; no Python code participates in production
extraction.

## Publication and verification

Publication validates the complete host, locks its repository-specific external
workspace, prepares external stages/backups, rechecks inputs and code, then
installs final files through a recoverable journal. It assumes cooperative
same-user writers and a shared lock namespace. Stages and repository must share
a filesystem. Readers can observe a transition between host-directory and index
renames; the two paths are not one atomic reader-visible operation. Unknown or
corrupt recovery artifacts fail closed and remain available for diagnosis.

Run focused and full tests, TypeScript, lint, formatting and existing dataset
validators with their ordinary timeouts. Test replay and the real
collector/serializer/publication handoff. Stage only reviewed files, then run
`npm run validate:host-change` to check staged/working identity, required host
components, final-only data paths and byte limits.

One substantive commit contains one complete hostname: module, tests/fixtures,
registry wiring, final host-list entry, final documents and necessary shared
changes. Partial or rejected hosts get no publication commit. Push each verified
hostname commit immediately to the feature ref only, without rewriting unrelated
history or pushing private backup refs.
