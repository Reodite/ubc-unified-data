# Official-host coverage

Use `data/official-hosts.json` for current published membership, category roots
and document counts. Coverage means complete collection within the declared
public article scope, not every page on every UBC site. The
[host contract](HOST-DOCUMENTS.md) defines admission and publication checks.
Private queues, recordings and partial outputs are not public exports.

## Reviewed restoration

[PR #5](https://github.com/Reodite/ubc-unified-data/pull/5) approved restoration of
50 previously withdrawn collections. It also records six campus-scope exceptions:

- `it.ok.ubc.ca`
- `lilab.ok.ubc.ca`
- `ors.ok.ubc.ca`
- `principal.ok.ubc.ca`
- `recreation.ok.ubc.ca`
- `vems.ok.ubc.ca`

The reviewed export correction excluded 195 placeholder-only records and
reconciled host/category counts without changing retained article bytes, routing
policies or original provenance. It establishes neither a new acquisition nor a
complete replay, and does not authorize automatic omission of required pages.

## Coverage accounting

Published, suitability-rejected, whole-host unavailable, withdrawn and incomplete
identities are separate dispositions. Matching aggregate counts does not establish
matching host membership. Specialized collections for
`bmlscpathology.med.ubc.ca`, `bullyingandharassment.ubc.ca` and `coop.ubc.ca` sit
outside the preserved recovery queue.

Queue reconciliation uses the latest host-specific successor row and explicit
migrated-copy tie precedence. Withdrawal receipts and reviewed restorations
determine current publication membership without rewriting earlier queue outcomes.
Original queues, recordings, seals, attempts and withdrawal backups remain in the
private workspace. Their presence is not an active acquisition/publication claim.

## Reviewed unavailable identities

These decisions apply to the exact HTTPS hostname and public article scope.
A redirect does not authorize collecting its destination under the old identity.

### Exact-host redirects

- `aboriginal.forestry.ubc.ca`
- `archivaria-ca.ezproxy.library.ubc.ca`
- `artsone-open.arts.ubc.ca`
- `biol.ok.ubc.ca`
- `ccr.ubc.ca`
- `cellphys.ubc.ca`
- `centennial-aboriginal.sites.olt.ubc.ca`
- `chinesecanadian.ubc.ca`
- `circle.sites.olt.ubc.ca`
- `cisar.iar.ubc.ca`
- `cjr.iar.ubc.ca`
- `ckr.iar.ubc.ca`
- `curio-ca.ezproxy.library.ubc.ca`
- `diginit.sites.olt.ubc.ca`
- `doi-org.ezproxy.library.ubc.ca`
- `elearning.ubc.ca`
- `events.library.ubc.ca`
- `heiltsuk.sites.olt.ubc.ca`
- `isitworkshops.arts.ubc.ca`
- `kx.ubc.ca`
- `lambranch.sites.olt.ubc.ca`
- `law-library.sites.olt.ubc.ca`
- `library-rbsc-2017.sites.olt.ubc.ca`
- `library.cms.ok.ubc.ca`
- `link-springer-com.ezproxy.library.ubc.ca`
- `med-fom-crhr.sites.olt.ubc.ca`
- `media.library.ubc.ca`
- `media3-criterionpic-com.ezproxy.library.ubc.ca`
- `muse-jhu-edu.ezproxy.library.ubc.ca`
- `rbsc-03feb2015.sites.olt.ubc.ca`
- `rbsc.sites.olt.ubc.ca`
- `stream-mcintyre-ca.ezproxy.library.ubc.ca`
- `www-proquest-com.ezproxy.library.ubc.ca`
- `www.events.ctlt.ubc.ca`
- `xwi7xwa-library-10nov2016.sites.olt.ubc.ca`

### Robots denies the homepage

- `daxue.ubc.ca`
- `ezproxy.library.ubc.ca`
- `ils.library.ubc.ca`
- `newbooks.library.ubc.ca`
- `openbadgessandbox.sites.olt.ubc.ca`

### Licensed-proxy exclusions

- `ubc.summon.serialssolutions.com.ezproxy.library.ubc.ca`
- `www-digitaliapublishing-com.ezproxy.library.ubc.ca`

## Withdrawn collections

Whole-host withdrawals preserve original bytes privately and leave acquisition
evidence intact. Required-page failures do not permit partial publication.

### Admission exclusions

The owner explicitly rejected `democracy.network.arts.ubc.ca`. Source content
establishes an Okanagan-only audience for the remaining hosts below; suffixes
alone do not establish campus scope. The approved exceptions above remain distinct.

- `democracy.network.arts.ubc.ca`
- `irsslab.forestry.ubc.ca`
- `learningspaces.ok.ubc.ca`
- `library.ok.ubc.ca`
- `nursing.ok.ubc.ca`
- `ok.ubc.ca`
- `socialwork.ok.ubc.ca`
- `ur.ok.ubc.ca`

### Sensitive source

`med-fom-spph-internal.sites.olt.ubc.ca` exposed shared access credentials in source
articles and archives. Its collection is excluded and admission checks refuse
republication. No credentials were used or tested. Withdrawal does not revoke
credentials or erase earlier remote copies; source operators must assess rotation.

### Required-content quality holds

These hosts have required pages with unfinished templates, empty/error responses,
broken renderings or access-denial notices. They remain withheld pending
source-specific review or complete verified repair. This does not establish that
their entire websites are unavailable.

- `campusmail.ubc.ca`
- `enunciate.arts.ubc.ca`
- `it.educ.ubc.ca`
- `mediastudies.arts.ubc.ca`
- `neurology.med.ubc.ca`
- `park.forestry.ubc.ca`
- `rbtlab.ubc.ca`
- `rerow.ubc.ca`
- `sportfacilities.ubc.ca`
- `strategicplan.library.ubc.ca`
- `stratplan-in-action.med.ubc.ca`
- `unitedway.ok.ubc.ca`
- `urology.med.ubc.ca`
- `www.biology.ubc.ca`
- `www.chinalinks.ubc.ca`

## Replay qualifications and remaining limits

`macl.arts.ubc.ca`, `mes.arts.ubc.ca`, `mtrl.ubc.ca`, `nitep.educ.ubc.ca`,
`rgst.arts.ubc.ca` and `smp.med.ubc.ca` passed complete offline replay from sealed
recordings without changing source receipts or attempts. Empty archive controls
require witnessed HTML roles/messages; conflicting CMS, sitemap, seed,
required-view or retained-document roles remain fatal. NITEP's replay also
excludes source-proven image/navigation-only pages and removes witnessed
trackback controls from alias metadata. Retained substantive bodies are unchanged.

Incomplete queue identities are neither scraped nor whole-host unavailable.
Failures include required HTTP 403/404/500 pages, changing publisher totals,
robots-restricted paths, private-login destinations, DNS/TLS errors and bounded
request/transport limits. A failed page or exhausted grant does not establish
whole-host inaccessibility.

Retained evidence includes incompatible WordPress totals at
`orthopaedics.med.ubc.ca`, a CWL-only section at `law.library.ubc.ca`, and an
advertised article returning 404 at `ore.educ.ubc.ca`. Duplicate recurring-event
records do not excuse changed totals on later API pages. Publication requires a
complete, internally consistent inventory under the current contract; retained
queues and recordings preserve each original attempt and failure for review.
