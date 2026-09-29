import { createHash } from "node:crypto";
import type { SearchDocument } from "./contracts.ts";

function comparisonBody(body: string): string {
  // Compare escaped punctuation and emphasis without changing retained text or its hashes.
  return body
    .replace(/\\([.*_])/g, "$1")
    .replace(/[*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const EMPTY_ARCHIVE_BODIES = new Set([
  "Apologies, but no results were found",
  "Apologies, but no results were found.",
  "Apologies, but no events were found for the requested venue.",
  "Apologies, but no events were found for the requested category.",
  "Apologies, but no events were found for the requested tag.",
  "Apologies, but no results were found for the requested archive.",
]);

/** Identify exact empty messages; archive exclusion also requires source-bound role and conflict checks. */
export function isKnownEmptyArchiveBody(body: string): boolean {
  return EMPTY_ARCHIVE_BODIES.has(comparisonBody(body));
}

const PLACEHOLDER_BODIES = new Map<string, string>([
  ...[...EMPTY_ARCHIVE_BODIES].map((body): [string, string] => [body, "empty results"]),
  ["You must be logged in as an instructor to view this content.", "instructor login notice"],
  ["Lorem ipsum… Lorem ipsum… Lorem ipsum…", "repeated Lorem placeholder"],
  [
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",
    "Lorem placeholder",
  ],
  [
    Array(3)
      .fill(
        "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.",
      )
      .join(" "),
    "repeated Lorem paragraph",
  ],
  [
    "Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industry’s standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book. It has survived not only five centuries, but also the leap into electronic typesetting, remaining essentially unchanged. It was popularised in the 1960s with the release of Letraset sheets containing Lorem Ipsum passages, and more recently with desktop publishing software like Aldus PageMaker including versions of Lorem Ipsum.",
    "typesetting placeholder",
  ],
  ["On this page", "navigation only"],
  [
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Fusce eget lobortis nibh. Phasellus risus mi, interdum eu tristique et, vestibulum vel tellus. Aliquam lectus nisi, lacinia vitae egestas vel, feugiat non tortor. Aenean nec eros eu urna mollis rutrum. Fusce nec lacus vel arcu tempus elementum. Nunc rutrum nibh vel leo tempus at interdum ipsum dignissim. Pellentesque tincidunt, est in bibendum euismod, ante orci interdum lacus, at dictum ante eros vitae massa.",
    "Lorem placeholder",
  ],
  [
    "Under Construction – this page is currently under construction and will be updated soon. You must be logged in as an instructor to view this content.",
    "construction and instructor login notice",
  ],
]);

const NOTICE_PLACEHOLDERS = new Set(
  [
    "News page here",
    "Events page goes here.",
    "Sorry, no posts matched your criteria.",
    "You are not allowed to view this content.",
    "This is for students.",
    "This page is for staff.",
    "This page is for faculty.",
    "This is the content of your about page",
    "Oops\\! We could not locate your form.",
    "Some paragraph",
    "To be posted",
    "test",
    "\\[portfolio\\_slideshow id\\=380\\]",
    "- xxxx - xxxx - xxxx",
    "- xxxxxxx - xxxxxxx - xxxxxxx",
    "Stay tuned for updates.",
    "This is a sample post.",
    "Coming soon...",
    "This page is under construction.",
    "A sample news post.",
    "Page under construction",
    "\\[table “3” not found /\\]",
    "blah",
    "Content coming soon",
    "Contents to be added.",
    "\\[profilelist\\]",
    "Coming Soon\\!",
    "Coming soon\\!",
    "## Coming soon\\!",
    "Coming Soon!",
    "Coming soon!",
  ].map(comparisonBody),
);

// These fingerprints cover complete normalized template bodies, including their fixed links and bylines.
const TEMPLATE_BODY_DIGESTS = new Map([
  ["7739e4a8fb901f53bc16c26fa54133c77abfbfa270e96ebbb3b37898ac9da1e0", "pop-culture news template"],
  ["eb211e57344ea2064e707cb9490a80f02f33b77096fe3db73d72b9a36a3d7450", "pop-culture staff template"],
  ["1ce80dcd24216d48051e37c74653317730a31b8ffed3a3153a4ddab65b6ae50b", "pop-culture blog template"],
  ["90dee30f0b78f6c676d4d16f048849233c97bc5ad8ce5e63829718265e0e2881", "unitedway Lorem template"],
  ["5d84c72255e0fcf3448125b2832846993bc7604cf352ad0ff714072a8c681d92", "midwifery draft template"],
  ["af35182e2c28ce7dd23cda75f6888b2461c23fe986dd2db2c366d8183215803e", "laboratory quality homepage template"],
  ["9e05a6c401ca653da64d27c340642a2f27f344269570b64e9eeb179b9192c6a1", "biology resource template"],
  ["2f9a7e27abec3ab8dd5d4f12d926a859bb71ee8491c3acedcad7cba7f84cef37", "biology equity template"],
  ["993aea5c82a447063e670466862aa43599596dac2d8c9dbb1895269566abb43e", "biology safety template"],
  ["3753becad84f60ed97bc6c3793156254d65ca8808bf2e0632ea269a373771408", "math component test page"],
  ["327cdedff399e17f271d712e449227f55412bd5c97a9df04eebbe3e8405adfa7", "research cluster profile template"],
  ["60ba7ce2dd910fe48c0a6b8765302ff6bbaed8a163e57c531c0f074bac9b18e0", "research cluster profile template"],
  ["32b8251112c22b41c48940f9d1cd5614ae2e6ecace341eb9f06d40deeefae0d2", "research cluster profile template"],
  ["d90bb38ea43fa4ceba8853506d6144703575a7ff4ee721f569c93a9dca270c54", "research cluster profile template"],
  ["118f017f707d45c5ad0b991c9765dd78f9a728196d254cab567369ff49c35d68", "research cluster profile template"],
  ["953daf165ec44888ba6ac0872bba1075cc7738a83edd9a1c11aa56d461992235", "research cluster profile template"],
  ["32ce896fcbdd594ecd8b5860c0f7201536940444fe7a705953ea8179e6997aa4", "research cluster profile template"],
  ["2ab1d11a8a402e829d7e495326bc9dffb60da5d6e3658c286fd10958463960c8", "lexicography introduction template"],
  ["e8c978dde543016e98e42bb5f0dddd1b2d3de293337ce66c712fd8342f5a7b02", "strategic plan example post"],
  ["9ec4b19f96407573a3881ea6b503f51e573d5f647133830b40e1b09d2e6c78e3", "learning spaces page-builder test"],
  ["af8bc4d926e81418e290ab6dc0ae2e3b4eca6b5c265c814940619bb1aa12ee27", "REDI news template"],
]);

/** Reject observed placeholder-only bodies, not articles that quote or discuss them. */
export function assertPublishableArticle(
  document: Readonly<Pick<SearchDocument, "content_markdown" | "source_url">>,
): void {
  const body = comparisonBody(document.content_markdown);
  const placeholder =
    PLACEHOLDER_BODIES.get(body) ??
    (NOTICE_PLACEHOLDERS.has(body) ? "unfinished source or access-denial notice" : undefined) ??
    TEMPLATE_BODY_DIGESTS.get(createHash("sha256").update(body).digest("hex"));
  if (placeholder)
    throw new Error(`Article body contains only a known placeholder (${placeholder}): ${document.source_url}`);
}
