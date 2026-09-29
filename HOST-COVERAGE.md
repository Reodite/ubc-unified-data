# Official-host crawl coverage

This repository publishes complete, validated hostname collections in
`data/official-hosts.json`. It does not publish private queues, recordings or
partial host output. [HOST-DOCUMENTS.md](HOST-DOCUMENTS.md) defines the article-only
scope and publication checks.

The preserved 500-host queue currently has these dispositions:

| Disposition                                                | Hosts | Public documents |
| ---------------------------------------------------------- | ----: | ---------------: |
| Published complete collections                             |   247 |           46,224 |
| Rejected during host suitability review                    |    72 |                0 |
| Reviewed as whole-host unavailable                         |    42 |                0 |
| Historically blocked, still requiring case-specific review |   139 |                0 |

The counts use the latest host-specific successor row, including the explicit
migrated-queue tie precedence. A blocked row remains in its original queue when
a separate reviewed unavailable disposition applies. The unavailable ledger and
its recording receipts live in the private external crawl workspace. The
published index includes none of the unavailable identities.

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

## Remaining limits

The other 139 blocked identities are not counted as scraped or whole-host
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
