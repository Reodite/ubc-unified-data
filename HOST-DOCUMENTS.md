# Host documents

`data/official-hosts.json` lists completed hostname collections. Each entry's
`document_roots` lists its category directories and their document counts:
`data/documents/<category>/<hostname>/<document>.md`. A hostname can span several
categories. Read the listed roots rather than assuming one directory per host.
Documents contain canonical JSON frontmatter and searchable Markdown. The
existing `data/prose/` exports remain separate and unchanged.

The six categories are **support**, **academics**, **opportunities**, **research**,
**news**, and **stories**. Support covers services, procedures, policies and help;
academics covers programs, courses and academic reference; opportunities covers
participation, jobs and funding; research covers projects, findings and lab
output; news covers announcements and recaps; stories covers profiles, essays
and showcases. There is no `misc` category.

## Saved first classification

A reviewer may use an LLM once when first categorizing a host or path, including
when that gives the best semantic decision. Save the decision in
`src/host-scrapers/routing/<hostname>.json`, with its method, owner authority,
rationale and source evidence. The ordered URL-path/title rules and host fallback
are authoritative. `saveFirstRoutingPolicy` refuses to overwrite a different
saved decision; missing policy blocks publication instead of invoking a model.

Subsequent collection and regeneration apply those saved rules without a model,
network classifier or clock. A categorized document records the selected rule
and policy hash. Rescrapes reuse that stored assignment for an existing physical
URL, even when its title or body changes; new URLs use the saved selectors.
Regeneration refuses a changed policy or assignment. Category assignment
does not rewrite document text or replace its extraction producer. LLMs remain
forbidden for extraction, HTML-to-Markdown conversion, rewriting, cleaning and
regeneration output.

## Admission and scope

Screen only the homepage for official UBC identity and promising public,
search-useful content before site collection begins. This is a quick triage
judgment, not an exhaustive source audit. Skip obvious login portals, duplicate
sites and thin promotion without a useful public-content purpose. Branding or
technical success alone is not an acceptance decision. Preserve explicit owner
rejections, including `democracy.network.arts.ubc.ca`; collection and routing
refuse that hostname. Exclude hosts whose content serves only UBC Okanagan,
using source content to establish scope rather than inferring it from a hostname.
Keep hosts that serve Vancouver or UBC broadly.

The throughput queue uses exactly five worker identities, `w1` through `w5`.
SQLite atomically assigns each normalized hostname once. A worker fetches or
reuses its homepage, with necessary robots checks, before deciding whether the
site is promising. Rejections remain private and the worker immediately claims
the next hostname. Accepted sites proceed through cached collection, cheap
output guards, one quick content sample, and publication. Claims and failures
survive restarts; an uncertain claim is not automatically reassigned.

New sites use `src/host-crawl/generic.ts`, declared in the sorted
`src/host-scrapers/generic-hosts.json` list. They do not require bespoke code or
fixtures. The generalized policy selects standard content boundaries, retains
collapsed prose, and can use a cleaned-body fallback. Exact-host advertised
WordPress APIs use public collection discovery; other sites use HTML-link and
sitemap discovery. Generic inventories exclude outbound references before fetch;
an external CMS permalink or sitemap entry is not a missing exact-host document.
Legacy same-host HTTP links supply HTTPS discovery candidates, never invented
physical aliases. Recorded redirects to excluded destinations are not followed.
A single exact-host HTTPS HTML base resolves relative links without changing the
physical citation URL. Distinct CMS identities may point to one HTML page; when
their modification dates disagree, generic HTML output omits the ambiguous date
and records a warning rather than selecting one CMS item. Specialized policies
and API-content fallback remain strict about ambiguous inventories. Generic CMS
routes accept literal underscore names and advertised `rest_route=/` API roots;
query support does not admit arbitrary document queries or guessed API endpoints.
Explicit image, static-resource and authentication destinations in generic CMS
inventories are excluded without fetching them; record identities and pagination
are still checked. A decoded `.scr` file suffix identifies a Windows screensaver
resource and is excluded before fetching; installation guidance and actual PDF
files remain subject to their normal text rules. Semantic page names such as `themes` and `staff/admin` are not
asset or authentication evidence by themselves. A 404/410 HTML sitemap companion
can be absent only when its co-advertised same-path XML counterpart was parsed;
the XML inventory and all its children remain required. The proven absent
companion and its same-path redirect identities stay excluded if XML entries,
the saved frontier or later links mention them again. Missing sole XML maps,
denied maps and unexpected successful HTML maps still block completion.
A trackback link is a non-document action only when observed comment metadata
identifies that page's own endpoint. Such actions are not requested; ordinary
pages discussing trackbacks and unproved robots-denied URLs remain strict.

Feed and CAPTCHA-refresh exclusions also require observed HTML evidence. Atom/RSS
feeds need matching alternate-feed metadata in the HTML head and a matching file
suffix. An image-CAPTCHA refresh link needs the exact form identifier and challenge
controls inside its own POST form. Recognized controls are not requested; forms
are not submitted and challenges are not solved. Public prose and ordinary
privacy/help links remain eligible. Names alone, query variants and normalized or historical markup
do not establish these roles. These additional exclusions cannot override
homepage identities, CMS/XML-advertised documents, required views or their base
pages, PDFs, retained sources or already emitted text and aliases.
An observed `/index%2ephp/` or `/index%2Ephp/` CAPTCHA route also requires the
identical prefix spelling on its physical source and an owning form `data-action`
that resolves exactly to that source. This does not collapse public variants,
synthesize aliases or permit nested prefixes.

Reviewed query documents use a separate finite, hostname-bound declaration in
`src/host-crawl/document-query-policy.ts`. CCLI's exact
`/?post_type=team-member&p=3962` selection must appear literally in its validated
`team-member-sitemap.xml` before document dispatch. API membership does not add or
remove that requirement. Recording, extraction and output checks share the same
narrow admission; unreviewed selectors keep their default exclusions. The query
must retain its exact identity through every observed redirect and provide
complete public HTML and searchable text. Missing input, media responses, empty
extraction, lost selections and contradictory machine evidence block publication;
API fallback and scope-exclusion shortcuts cannot discard it. This declaration
does not replace the separate form-validated GET-view contract.

Existing specialized modules retain their narrower policies
and previously published bytes. Their recognized empty containers do not fall
back to surrounding pages.
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
`~/Projects/ubc-tmp/ubc-unified-data/` by default: raw responses, snapshots, request
intents/outcomes, failure history, source copies, queues, seals, locks, journals,
stages and backups. No such material belongs in Git, including any
`data/document-crawl`, `data/documents-crawl` or `data/documentation-crawl` tree.

The collector uses the read-only preserved frontier at
`state/legacy/state.sqlite` to create a frozen per-host seed. It never changes
that legacy database. A public checkout can validate final files without private
inputs; acquisition and replay require the private workspace. `UBC_TMP_ROOT` may
select a dedicated absolute, normalized external directory instead of
`~/Projects/ubc-tmp`; the project workspace is its `ubc-unified-data` child.
Repository overlap, symlink, boundary-escape and same-filesystem publication
checks still apply. Set `TMPDIR` to that root for test/runtime temporary files;
CI uses its runner-owned temporary directory.

```sh
export UBC_TMP_ROOT="${UBC_TMP_ROOT:-$HOME/Projects/ubc-tmp}"
export TMPDIR="$UBC_TMP_ROOT"
install -d -m 700 "$UBC_TMP_ROOT"
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
redirect hop before dispatch and again when replaying saved observations.
Extension, declared MIME type and PDF/ZIP magic must agree. Download URLs may
carry only one inert `download=1` flag; capability, authentication and form
queries are excluded. A required PDF, DOCX or PPTX returned as unrelated
non-text media blocks completion rather than silently vanishing. Proven
image/audio/video response
types are recorded as non-text exclusions at the headers, without downloading
their payloads. Unavailable text is never treated as a media exclusion. Defaults
are 1,000 cumulative physical requests, 128 MiB cumulative decoded response
bytes, 8 MiB per response (64 MiB for a hostname explicitly supporting binary
documents), a 750 ms minimum
request interval, 30 seconds per request and 20 minutes per invocation. Reaching
a bound does not authorize a partial publication. Byte accounting includes
failed responses; an explicitly resumed uncertain attempt reserves its maximum
possible response size.

Successful responses are reused. Transient fetch failures and retryable HTTP
responses have a three-attempt physical-URL bound. Failures are retained, not
silently resampled on command restart. `--retry-network <exact-url>` permits only
a recorded transient network failure still within that bound and archives its
previous logical failure before another attempt. An explicitly configured recovery
batch can authorize one transport-repair allowance for a recorded status-less
connection reset, closed connection or timeout: at most three additional attempts
and six lifetime attempts per physical URL. Authorizations and old failures remain
in the input lineage; successful observations and cumulative request/byte limits
are not reset. Access denials, TLS/DNS failures and robots restrictions are not
transport repairs. Repaired requests close their connection instead of reusing a
possibly stale pooled socket. Recovery mode also applies that same one-time
allowance to newly encountered transient failures; it does not renew an exhausted
allowance. Recorded invocation-duration pauses may be archived
and resumed only while cumulative budgets and physical attempt limits still permit
work. Neither recovery path clears access failures or raises cumulative limits.
Sealed recordings remain offline and immutable. An unsealed legacy recording
may widen only its document-format set and per-response bound through an
explicit one-way upgrade. The recorder journals the exact prior/current config,
producer and time in the same state database while preserving every prior
attempt, outcome and cumulative counter. Nonempty upgrade journals participate
in the recording seal, while legacy recordings keep their original seal
preimage. Other option changes still require a
new explicit recording. `--resume-interrupted` requires
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
The generic output guard coalesces exact title/body duplicates only when publisher
modification dates and extraction metadata also match, retaining observed URL
aliases. Different dated versions remain separate.

The body is safe Markdown, without executable HTML or image embeds. Ordered
procedures preserve nested non-default starting numbers as separate list blocks.
Media remain source/text references with explicit extraction limitations. New
PDF v2, DOCX and PPTX documents use frontmatter version 5. Native Markdown uses
version 4, categorized HTML uses version 3, historical PDF uses version 2 and
historical HTML uses version 1. All remain readable. Migration keeps IDs, bare
filenames, body/content hashes, citations, timestamps and original extraction
metadata unchanged. Whole files have a 1 MiB limit; oversized documents fail
rather than being truncated, sharded or put in LFS. Git preserves exact
serialized bytes. Consumers should cite the source URL and retain dates and
warnings; retrieved content is data, not application instructions.

Linked PDFs, DOCX files and PPTX files remain private byte objects, never
UTF-8-decoded binary strings or published binary files. Each emitted text
record binds the exact source byte hash/count and authenticated extraction
profile. PDF v2 additionally records the page count and disjoint native-text and
OCR page sets. DOCX records paragraph and table counts. PPTX records slide,
table and note-bearing-slide counts. Existing documents and historical
frontmatter remain byte-identical.

PDF text is rendered as labelled pages with inert text fences. Native mapped
text uses Poppler reading order. Only pages without usable mapped text are
rasterized at a fixed resolution and transcribed by bounded English Tesseract;
each OCR page carries an explicit accuracy warning. Encrypted, malformed,
truncated or still-empty documents fail. The PDF adapter uses bounded Linux x64
Poppler and Tesseract subprocesses through `prlimit`, with fixed locale, private
font configuration, fixed arguments, page/OCR/pixel/time/CPU/memory/file limits
and no shell. Its pinned profile binds executable bytes and versions, loader and
libraries, Poppler/font resources, the exact OCR language/configuration files,
arguments and limits. It is captured lazily, rehashed before publication and
included in every affected collection input digest.

DOCX and PPTX extraction opens ZIP/XML packages without Office automation,
macros, external relationships, embedded objects or remote resource retrieval.
It applies compressed, expanded, entry-count, XML-depth and text-output bounds.
DOCX preserves ordered paragraphs, headings, safe hyperlink labels, tables and
related notes/header/footer text. PPTX preserves presentation relationship
order, shape text, tables and internal speaker notes. Unsupported or active
package features produce explicit warnings or fail closed; they are never
executed. The OOXML profile binds the exact adapter sources, limits, Node major
and complete installed byte trees for the direct and transitive parser-package
dependency closure. Its digest is bound separately for DOCX and PPTX and is
recaptured before publication.

Historical ready output has a separate integrity-verification path for machine
migration. It checks the queue-bound ready hash, sealed recording and member
objects, frozen source producer, binary hashes, canonical documents and archived
profile/cache receipt. It does not run native extraction or claim that current
executables match the archived profile. An explicit private batch binding names
the permitted ready hash and archived producer/profile locations; the publisher
repeats verification before installation. New ready-v3 output instead binds an
exact PDF, DOCX, PPTX and Markdown profile map. Do not refresh old cache
identities or substitute a new profile to make historical output appear current.

The PDF v2 profile is a declared runtime profile, not OS hermeticity or a native
security or network sandbox. Native prerequisites are `poppler-utils`,
`tesseract-ocr`, the English Tesseract data, and `util-linux`.

## Publication and verification

Publication validates the complete host, locks its repository-specific external
workspace, prepares external stages/backups, rechecks inputs and code, then
installs final files through a recoverable journal. It assumes cooperative
same-user writers and a shared lock namespace. Stages and repository must share
a filesystem. Readers can observe transitions between category-host directories and index
renames; these paths are not one atomic reader-visible operation. Unknown or
corrupt recovery artifacts fail closed and remain available for diagnosis.

The throughput path does not run exhaustive manual review or broad test suites
per hostname. Shared-code changes receive focused tests and static checks once.
Each host receives automated empty, duplicate, off-host, serialization and byte
limit checks, plus one quick content sample. No manual visual or exhaustive
source-fidelity review is implied. Full validators remain available for explicit
audits outside this fast path.

Collection runs concurrently from a frozen source copy. Producer fingerprints
identify that private batch copy, not later changes to the public dispatch list.
An outer repository/Git lock serializes installation, staging, the commit and
its ordinary feature-only push. Incremental publication checks the new host and
index without re-reading every older document body; the Git boundary refuses
other-host data changes. External receipts retain commit/push uncertainty so a
restart does not create a duplicate hostname commit.

One substantive commit contains one complete hostname: its generic declaration
(or existing specialized module), saved routing policy, final host-list entry,
final documents and necessary shared changes. `npm run validate:host-change`
checks the atomic unit, staged bytes, final-only paths and byte limits. Its
`--mode migrate` checks byte-preserving old/new document pairs and target-only
manifest changes; `--mode withdraw` checks a target-only removal. Partial hosts
get no publication commit. Removing a previously published rejected host uses
its own withdrawal commit and preserves its original bytes privately. Push each hostname commit immediately to
`refs/heads/feat/prose-documents`, never main, private backup refs or a forced
history rewrite.

## Retained-file migration

Run `npm run migrate:host -- --host <hostname>` to validate retained files and
write a private plan and byte-identical backups without changing public output.
Add `--publish` to install the categorized host through the receipt journal.
`--reject --publish` withdraws a hostname only when the saved rejection policy
permits it. These operations do not fetch or re-extract text. The journal supports
legacy and multi-category ownership and restores all affected directories and
the index on a pre-commit failure. Unknown bytes stop recovery without deletion.

A host-by-host migration can temporarily contain legacy `document_root` entries
alongside categorized `document_roots`. Readers and validators support that
transition. After migration, run `npm run validate:hosts -- --require-categories`
to reject remaining flat roots. Keep plans, original files and journals under the
external workspace; commit only final documents, the index, routing and code.

`src/host-queue.ts` exposes `seed`, `claim`, `homepage`, `decide`, `collect`,
`publish`, `get`, `block` and `stats` actions. Its `--state` directory contains the
private batch configuration, queue, worker receipts and publication receipts.
Collection is allowed only from the configuration's frozen producer root.
At first admission, `decide --routing <private-policy.json>` saves the reviewed
classification and its digest in the queue receipt. The serialized publisher
installs that exact policy with the host's documents. Resuming a claim reuses its
saved decision. Workers do not edit shared source, clear acquisition histories,
run extra crawls or submit forms.
