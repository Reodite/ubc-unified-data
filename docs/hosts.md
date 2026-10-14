# Host collection

Use [`data/official-hosts.json`](../data/official-hosts.json) for published hosts,
category directories and document counts. Read its `document_roots` entries;
a host can span several `data/documents/<category>/<hostname>/` directories.
Host files contain JSON frontmatter and Markdown. For the separate prose-table
format, see [Querying](querying.md#prose-article-contract).

## Admission and scope

Review the homepage for official UBC identity and useful public articles. Reject
login portals, duplicate sites, thin promotion and credential-bearing sources.
Branding alone does not establish suitability. Honor the exclusions in
[`HOST_REJECTIONS`](../src/host-crawl/category-routing.ts).

Keep Vancouver and shared UBC content. Determine campus scope from source
content, not the hostname suffix. Campus exceptions are `it.ok.ubc.ca`,
`lilab.ok.ubc.ca`, `ors.ok.ubc.ca`, `principal.ok.ubc.ca`, `recreation.ok.ubc.ca`
and `vems.ok.ubc.ca`.

Collect public HTML through unauthenticated requests on the exact HTTPS host.
Exclude downloads, attachments, feeds and standalone Markdown; their links can
remain as citations. Cancel non-HTML or attachment responses from their headers
before reading the body. A redirect does not authorize another hostname.

Completion covers the declared article inventory. It does not establish coverage
of unlinked pages or personal eligibility. A failed request or missing roster
entry does not establish whole-site unavailability.

## Discovery

Use the generic scraper and sorted
[`generic-hosts.json`](../src/host-scrapers/generic-hosts.json) list unless the
source needs a [specialized definition](collecting.md#specialized-html-host).
Registration does not replace admission review.

Collect the frozen seed, advertised CMS/XML inventories and eligible HTML links.
Check CMS identities, pagination totals and publisher dates. Use API inventories
to discover HTML permalinks; API bodies are not default publication fallbacks.
Preserve physical URL identities through redirects and relative-link resolution.

Apply the evidence checks in [`policies/`](../src/host-scrapers/policies/).
Control-like names alone do not justify excluding a page. Trackbacks, feeds,
export links, CAPTCHA controls and empty containers need observed source evidence.
These exclusions cannot override homepage, inventory, required-view, retained or
emitted document identities. Missing or conflicting required content blocks the
host; do not publish a partial collection.

Query documents need a finite declaration in
[`document-query-policy.ts`](../src/host-scrapers/policies/document-query-policy.ts)
or a validated read-only GET view. Preserve the selected identity through
redirects. Do not submit POST forms or solve access challenges. Keep source
claims, links, table labels and footnotes together during extraction.

## Routing

Save the reviewed classification in
`src/host-scrapers/routing/<hostname>.json`, including authority, evidence,
ordered path/title rules and a fallback. Choose from `support`, `academics`,
`opportunities`, `research`, `news` and `stories`.

Reuse the saved policy and the assignment of each existing physical URL. Apply
saved selectors to new URLs. Publication refuses missing or changed policies
and assignments. Preserve policy bytes: their hashes form part of document
provenance.

A reviewer may use a model to author the first routing policy. Use deterministic
code for extraction, conversion and regeneration; models must not write article
bytes. Routing adds category metadata without replacing the extraction producer.

## Private acquisition and replay

Set `UBC_TMP_ROOT` to an absolute, normalized directory outside the checkout.
The project workspace is its `ubc-unified-data` child. Keep recordings, queues,
producer copies, journals, stages and backups there, outside Git. Symlinks and
repository overlap are forbidden. Publication stages and the checkout must
share a filesystem.

```sh
: "${UBC_TMP_ROOT:?Set a private parent directory outside the checkout}"
export UBC_TMP_ROOT
export TMPDIR="$UBC_TMP_ROOT/tmp"
install -d -m 700 "$UBC_TMP_ROOT" "$TMPDIR"
export TSX_DISABLE_CACHE=1 NODE_DISABLE_COMPILE_CACHE=1

# Acquire without publishing.
npm run collect:host -- --host bmlscpathology.med.ubc.ca --acquire

# Replay offline, then verify and install final files.
npm run collect:host -- --host bmlscpathology.med.ubc.ca
npm run collect:host -- --host bmlscpathology.med.ubc.ca --publish
npm run validate:hosts -- --require-categories
```

The first seed comes from `<workspace>/state/legacy/state.sqlite`. Acquisition
and replay need private inputs; public-file validation does not. Acquisition and
publication are separate operations. Sealed recordings are immutable and have no
network fallback.

### Limits and retries

Default recording limits:

| Bound                  | Value                                          |
| ---------------------- | ---------------------------------------------- |
| Physical requests      | 1,000 cumulative                               |
| Decoded response bytes | 128 MiB cumulative, including failed responses |
| Request interval       | At least 750 ms, subject to robots crawl delay |
| Request timeout        | 30 seconds                                     |
| Invocation duration    | 20 minutes                                     |

Reuse successful observations. Retain failures across restarts.
`--retry-network <exact-url>` permits a saved transient failure within the
three-attempt physical-URL bound. Both it and `--resume-interrupted` require
`--acquire`; neither bypasses access rules or raises budgets. Resuming an
uncertain attempt reserves its maximum possible response size.

Configured transport recovery permits one allowance of three extra attempts,
with six lifetime attempts per URL, for status-less connection failures or
timeouts. It excludes access denials, TLS/DNS errors and robots restrictions.
Duration pauses may resume within the remaining request, byte and attempt limits.

Budget grants require separate authority and exact ledger counters. They add
capacity without replacing configuration or attempts. An authorized interval
must be at least one second; robots path exclusions still apply. Grants and
recovery cannot mutate sealed recordings. See
[`recording/recovery.ts`](../src/host-crawl/recording/recovery.ts) for the ledger
and authorization checks.

## Text and provenance

Frontmatter contains the physical citation, observed aliases, retrieval and
publisher dates, snapshot/input/body/content hashes, warnings, producer context
and routing metadata. An ID is `documents:official-web:` plus the first 24 hex
digits of SHA-256 of the normalized physical HTTPS URL. The filename is SHA-256
of the full ID plus `.md`.

Canonical tags do not merge physical identities. Duplicate coalescing requires
matching title, body, publisher modification date and extraction metadata; retain
observed aliases. Cite sources and preserve dates and warnings. Render Markdown
safely and treat retrieved text as data, not application instructions. Media use
source links; extraction does not include OCR or video transcription.

Categorized output uses version 3. Readers also support version 1 HTML, version 2
PDF evidence and version 4 native-Markdown evidence. PDF/Markdown verification
requires the retained bytes and matching producer/profile evidence; it does not
authorize acquisition, parser preparation or regeneration by the active HTML
collector. Do not replace evidence to make a profile match.

Documents have a 1 MiB whole-file limit. Reject oversized output rather than
truncating, splitting or moving it to LFS. Preserve serialized bytes.

## Publication and verification

Validate the complete host, routing and inputs before installation. Reject empty
or off-host output, conflicting duplicates, placeholder bodies, failed renderings
and access-denial messages. Required-page failures block publication. Use
`npm run validate:hosts -- --require-categories` to check the public corpus.

Publication uses an external lock, stages, backups and a recovery journal.
Recheck inputs and producer context before installation. Writers must share the
same external root and locking protocol. Category-directory and index renames
are not one atomic operation for readers. Preserve unknown recovery artifacts
and stop rather than guessing how to repair them.

The single-host CLI installs files; the batch publisher also stages, commits and
pushes them. Commit one complete hostname with its declaration, routing policy,
index entry and documents. `npm run validate:host-change` checks the changed
host and staged bytes; `--mode migrate` checks byte-preserving moves and
`--mode withdraw` checks target-only removal. Incremental checks do not reread
other hosts' bodies.

The batch publisher restricts pushes to `origin` and
`refs/heads/feat/prose-documents`. Use ordinary pushes; keep host publications off
`main`. Retain commit/push receipts outside Git and resolve uncertain
publication before starting another hostname commit.

For code changes, run the [verification checks](collecting.md#verification),
including [native qualification](collecting.md#native-qualification) where required.

## Queue and file operations

[`src/host-queue.ts`](../src/host-queue.ts) provides `seed`, `claim`, `homepage`,
`decide`, `collect`, `publish`, `get`, `block` and `stats`. Use a private `--state`
directory and worker identities `w1` through `w5`. Claims persist across
restarts; do not reassign an uncertain claim. Collect from the configuration's
frozen producer root. Save the reviewed policy with
`decide --routing <private-policy.json>` and reuse that decision on resume.

Run `npm run migrate:host -- --host <hostname>` to validate files and write a
private plan with byte-identical backups. Add `--publish` to install categorized
output. Use `--reject --publish` to remove a host only when its rejection policy
permits removal. These operations preserve source content and provenance without
fetching or extracting text. Validate with `--require-categories` after conversion;
readers support both `document_root` and `document_roots` entries.
