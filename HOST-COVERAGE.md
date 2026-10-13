# Official-host crawl coverage

This repository publishes validated hostname collections in
`data/official-hosts.json`. It does not publish private queues, recordings or
partial host output. [HOST-DOCUMENTS.md](HOST-DOCUMENTS.md) defines the article-only
scope and publication checks.

The current release contains **226 hostname collections and 42,866 documents**.
Coverage applies to the declared public article scope, not to all UBC sites.

The owner-approved restoration in [PR #5](https://github.com/Reodite/ubc-unified-data/pull/5)
keeps 50 previously withdrawn collections. Six are approved campus-scope
exceptions: `it.ok.ubc.ca`, `lilab.ok.ubc.ca`, `ors.ok.ubc.ca`,
`principal.ok.ubc.ca`, `recreation.ok.ubc.ca` and `vems.ok.ubc.ca`.
The public export excludes 195 known placeholder-only records after review;
category and host counts reflect those exclusions. Retained article bytes,
routing policies and original provenance are unchanged. This correction does
not establish a new acquisition or complete replay.

The preserved 500-host recovery queue has these current dispositions:

| Disposition                                                |   Hosts | Public documents |
| ---------------------------------------------------------- | ------: | ---------------: |
| Published collections from this queue                      |     223 |           42,798 |
| Rejected during host suitability review                    |      72 |                0 |
| Reviewed as whole-host unavailable                         |      42 |                0 |
| Withdrawn after acceptance or publication review           |      24 |                0 |
| Historically blocked, still requiring case-specific review |     139 |                0 |
| **Total recovery queue**                                   | **500** |       **42,798** |

Three specialized collections sit outside that queue: `bmlscpathology.med.ubc.ca`
(30 documents), `bullyingandharassment.ubc.ca` (6) and `coop.ubc.ca` (32). Their
68 documents account for the difference between the queue and the full corpus.
Matching aggregate counts alone does not establish matching host membership.

Queue reconciliation uses the latest host-specific successor row and the
explicit migrated-copy tie precedence. Withdrawal receipts and reviewed
restorations determine current publication membership without rewriting earlier
queue outcomes.
Unavailable dispositions remain separate from withdrawals and incomplete work.
The original queues, recordings, seals, attempts and withdrawal backups stay in
the private external workspace. No acquisition or publication claim is active.

## Reviewed unavailable identities

The ledger records 35 exact-host redirects, five robots policies denying the
homepage and two licensed-proxy exclusions. These identities are unavailable
_under the declared exact HTTPS hostname and public article scope_. A redirect
does not authorize collecting its destination under the old name.

**Exact-host redirects (35):**

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

**Robots denies the homepage (5):**

- `daxue.ubc.ca`
- `ezproxy.library.ubc.ca`
- `ils.library.ubc.ca`
- `newbooks.library.ubc.ca`
- `openbadgessandbox.sites.olt.ubc.ca`

**Licensed-proxy exclusions (2):**

- `ubc.summon.serialssolutions.com.ezproxy.library.ubc.ca`
- `www-digitaliapublishing-com.ezproxy.library.ubc.ca`

## Withdrawn collections

The release excludes 24 previously accepted collections after the reviewed
restorations. Each whole-host withdrawal retains original bytes privately and
leaves historical acquisition evidence intact. The placeholder exclusions above
are an explicit export review, not a collector fallback for required-page failures.

**Admission exclusions (8):** The owner explicitly rejected Democracy. Retained
content establishes an Okanagan-only audience for the other listed hosts; a
hostname suffix alone does not establish campus scope. The six approved
exceptions listed above are not excluded.

- `democracy.network.arts.ubc.ca`
- `irsslab.forestry.ubc.ca`
- `learningspaces.ok.ubc.ca`
- `library.ok.ubc.ca`
- `nursing.ok.ubc.ca`
- `ok.ubc.ca`
- `socialwork.ok.ubc.ca`
- `ur.ok.ubc.ca`

**Sensitive source (1):** `med-fom-spph-internal.sites.olt.ubc.ca` exposed shared
access credentials in source articles and archives. Its collection is absent
from this release, and admission checks refuse republication. No credentials
were used or tested. Withdrawal does not revoke credentials or erase earlier
remote copies; source operators must assess any credential rotation.

**Required-content quality holds (15):** These collections contain required
pages whose saved output is an unfinished template, an empty/error response,
a broken rendering or an access-denial notice. They remain withheld pending
source-specific review or a complete verified repair. This is not a finding
that their entire public websites are unavailable.

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

Six other collections passed complete, offline replay from sealed source
recordings: `macl.arts.ubc.ca`, `mes.arts.ubc.ca`, `mtrl.ubc.ca`,
`nitep.educ.ubc.ca`, `rgst.arts.ubc.ca` and `smp.med.ubc.ca`. Their source receipts
and attempts are unchanged. Exact empty archive controls require witnessed HTML
roles and messages, with conflicting CMS, sitemap, seed, required-view or
retained-document roles still fatal. NITEP's replay also excludes source-proven
image/navigation-only pages and removes witnessed trackback controls from alias
metadata. All retained substantive article bodies are unchanged.

## Remaining limits

The 139 earlier blocked identities are not counted as scraped or whole-host
unavailable. They include required pages returning HTTP 403, 404 or 500; saved
publisher inventories whose totals changed during pagination; robots-restricted
paths; private-login destinations; unresolved DNS/TLS failures; and bounded
request or transport limits. A failed page or exhausted grant does not establish
that every public page on its host is inaccessible.

For example, `orthopaedics.med.ubc.ca` reported incompatible WordPress totals
across saved pages. `law.library.ubc.ca` exposed a CWL-only section.
`ore.educ.ubc.ca` advertised an article whose HTML returned 404. Several
recurring-event hosts exposed exact duplicate event records, but a later API
page reported a different total. None can enter `data/official-hosts.json`
without a complete, internally consistent public inventory under the current
contract. Each retained queue and recording preserves its original attempt,
access decision and failure evidence for later review.
