import { createHash } from "node:crypto";
import { load } from "cheerio";
import type { Observation } from "./contracts.ts";
import { hostUrl } from "./urls.ts";

const hostname = "www.msl.ubc.ca";
const origin = `https://${hostname}`;

const labels: Readonly<Record<string, readonly string[]>> = {
  "dr-brian-ellis": ["Brian Ellis", "Brian Ellis,"],
  "dr-cara-haney": ["Cara Haney", "Dr. Cara Haney", "Dr. Cara Haney’s"],
  "dr-christian-kastrup": ["Christian Kastrup", "Dr. Kastrup", "Dr. Christian Kastrup"],
  "dr-robin-turner": ["Robin Turner", "Dr. Robin Turner", "Turner", "Prof. Turner"],
  "dr-stephen-withers": ["Steve Withers", "Stephen Withers", "Stephen Withers, MSL", "Withers lab"],
};

export type MslCitationWitness = readonly [
  sourcePath: string,
  sourceSnapshotSha256: string,
  targetSlugs: readonly string[],
];

export const reviewedMslCitationSources: readonly MslCitationWitness[] = [
  [
    "/about-us/",
    "3f803272578d79e5917381eb639c342e03cd1807091eaf32eaf8e2dd4ce5fd11",
    ["dr-brian-ellis", "dr-cara-haney", "dr-christian-kastrup", "dr-robin-turner", "dr-stephen-withers"],
  ],
  [
    "/anne-sophie-sack-and-jacob-wardman-awarded-2021-william-and-dorothy-gilbert-scholarships/",
    "9fffe1db0e0b66436f727ed6f1bb873545e914d8dcecb1b2ab10e6781b87d59b",
    ["dr-stephen-withers"],
  ],
  [
    "/christian-kastrup-named-2016-msfhr-scholar/",
    "172034bc7f2ff2e5fbf52221fd795f10e680aa3539bc19084fa2ad6a2236b9a7",
    ["dr-christian-kastrup"],
  ],
  [
    "/christian-kastrup-transitions-lab-to-the-medical-college-of-wisconsin/",
    "4297f5f236159fd38ce05b2729fa64529c1c78b5a4ca99cb5420758ef3c094f6",
    ["dr-christian-kastrup"],
  ],
  [
    "/congratulations-to-dr-cara-haney-for-receiving-a-canada-research-chair-tier-2-award/",
    "4d038ede031847933b0dbb9fb8d578dc07737e09f95b8d24edccafd0abd26a5c",
    ["dr-cara-haney"],
  ],
  [
    "/developing-a-new-analytical-technique-to-assess-the-quality-of-blood-without-breaching-the-sterility-of-transfusion-bags/",
    "670e8eb40d0e6aff6501586c894714c8f12517e69c9247d42059fd2799a739c3",
    ["dr-robin-turner"],
  ],
  [
    "/discovery-of-new-genes-in-root-microbiome-harmful-or-helpful-for-plants/",
    "80717242de66684cee74264eb19b9d428de9f95d1b9b29a66152641491f9198b",
    ["dr-cara-haney"],
  ],
  [
    "/dr-christian-kastrup-wins-the-major-sir-frederick-banting-award/",
    "956be4f65f9f6dcb118c39cda73e9dfe0266f8cbe04bc045ff6618f3754a43d4",
    ["dr-christian-kastrup"],
  ],
  [
    "/drs-james-piret-and-robin-turner-receive-william-f-meggers-award/",
    "b9ab1a1df6590571dba4ea0def403d21f2b4d7fe86947e2d1127ad8f57b1a0b8",
    ["dr-robin-turner"],
  ],
  [
    "/drs-robin-turner-and-james-piret-address-the-practical-questions-when-using-raman-spectroscopy/",
    "07a3c66823131ef4ecf11f9b727ab99a3fc17bcf10e47a1ba44b704a25daee66",
    ["dr-robin-turner"],
  ],
  [
    "/drs-robin-turner-and-james-piret-explain-ramen-spectroscopy-and-its-uses/",
    "f2cec07bf9622325ff845c69468bfd3c0183c30c31e8a60a56894b946ccb0f13",
    ["dr-robin-turner"],
  ],
  [
    "/enzymes-from-the-gut-microbiome-can-convert-type-a-blood-to-universal-o-type/",
    "39f63e22c82bbad3191fb3913b18f4c205efbe02250e21bdb73cc8098212b891",
    ["dr-stephen-withers"],
  ],
  [
    "/four-faculty-members-receive-cihr-foundation-grants/",
    "437794fc152bc949f9e4ee0e72ba4a99ed41c1e2f75b36241d6af231574f5301",
    ["dr-christian-kastrup", "dr-stephen-withers"],
  ],
  [
    "/going-against-the-flow-self-fuelled-microparticles-deliver-cargo-through-flowing-blood-to-stop-hemorrhage/",
    "9a0154d988e933d9aa53da476cd7564660f0569cb2d22bd31a2c5a6242e6d649",
    ["dr-christian-kastrup"],
  ],
  ["/kickstart/", "45161ae25e8dd5c0756b06e00b6ecefa8223bc91a1b2d5830d571685a23de52a", ["dr-cara-haney"]],
  [
    "/look-down-in-the-petri-dish-its-a-superplatelet/",
    "41dcf519a21e6281a5702b82de976e8ce9e5b5f0c6f6fd5026f1567d7fb51bf1",
    ["dr-christian-kastrup"],
  ],
  [
    "/meet-the-researcher-dr-christian-kastrup/",
    "af315a3467a19aa840be1a2d9c4f13a42b4196d43fdc30032c95c90f70bb145e",
    ["dr-christian-kastrup"],
  ],
  [
    "/minister-ambrose-announces-new-glycomics-research-network-to-prevent-and-treat-diseases/",
    "f9f583aa47fd5eeb728fbb12be11c6b305cdda478a6f6c0ec4d39d7319839195",
    ["dr-stephen-withers"],
  ],
  [
    "/ms-25th-anniversary-celebration-of-michael-smiths-nobel-prize-symposium-in-review/",
    "63c18fddd5ae37c51a146e009c8c4b761ec9336b62eed52a3dd8ba35265a24ed",
    ["dr-christian-kastrup"],
  ],
  [
    "/people/associate-members/",
    "fdab597ae6ea498f2087214acb667fff65fc7d862d49d5cf8c3feea74b4eec32",
    ["dr-stephen-withers"],
  ],
  ["/people/dr-james-piret/", "125cdbb632795f0b57e24df8a8e40866038c8f4cd544e39bda33b9e5268f18bc", ["dr-robin-turner"]],
  [
    "/raman-spectroscopy-used-to-distinguish-cell-death-and-apoptotic-stages-in-chinese-hamster-ovary-cells/",
    "71aedf7bbe3e0daf704597f192355e89ff75d4726edc167065253302dc20cd2e",
    ["dr-robin-turner"],
  ],
  [
    "/research/engineering-and-analysis-of-complex-biological-systems/",
    "be6624cd8528b165e2e6ceffc95b7b791c6f00dcbc70ab21ef243b7e669f36e7",
    ["dr-robin-turner"],
  ],
  [
    "/seyed-amirhossein-nasseri-a-phd-student-in-the-withers-lab-announced-as-a-2018-2019-vanier-scholar/",
    "8150867cda09c2421373206ec100f764d31d25f1a10b545dbcb186c89b57265e",
    ["dr-stephen-withers"],
  ],
  [
    "/soil-and-deadly-bleeding/",
    "405bf21973d13afb98b5829bcfd842567bb00433f0aed9144ed0664d887be69c",
    ["dr-christian-kastrup"],
  ],
  [
    "/thinking-small-in-the-face-of-climate-change/",
    "1fc98eac55a145c7186b33941b4b290826ef5ddb685d5610c6c9dddfd76b0c59",
    ["dr-cara-haney"],
  ],
  [
    "/three-msl-members-projects-highlighted-on-glyconets-top-10-stories-of-2021/",
    "cf8e3afaa07f9548dc56a968b44ca32bde125f0b91782b5e398d7ddb27e8abc7",
    ["dr-stephen-withers"],
  ],
  [
    "/timeline/",
    "45f0a27ea144eef172159e0580d08cf00f2caf39821366c08d608c56b7346228",
    ["dr-brian-ellis", "dr-christian-kastrup", "dr-robin-turner"],
  ],
  [
    "/timeline/centre-for-high-throughput-biology-chibi-founded/",
    "890e954ab2f3835fe5bbcfdb1cbc2dff965fa8d43e82d294143159d32d9af9ce",
    ["dr-brian-ellis"],
  ],
  [
    "/timeline/comotion-drug-delivery-systems-inc-formed/",
    "6cc41c76fe53fc502e9476fbb1329a9a1a6719bebccf1446e3621b3bdf18c2de",
    ["dr-christian-kastrup"],
  ],
  [
    "/timeline/creation-of-platelets-with-synthetic-nuclei-rna/",
    "18b4cec25451ed909081bbc94ae5fc8fa5ad0fe10e8caba3c1dad718d914c04e",
    ["dr-christian-kastrup"],
  ],
  [
    "/timeline/elements-of-precaution-recommendations-for-the-regulation-of-food-biotechnology-in-canada-report-released/",
    "09d9bfc04ecf2ea861d9ead7d90e4a337324b0edc51c74eeeda910c58da50155",
    ["dr-brian-ellis"],
  ],
  [
    "/timeline/first-fiber-optic-linked-uv-resonance-raman-spectroscopy/",
    "b1691896f4ced17fbfe8fdf1a1025f6f822201d16f8addbe389ebee6bfca07d2",
    ["dr-robin-turner"],
  ],
  [
    "/timeline/first-in-situ-analysis-of-red-blood-cell-concentration-to-assess-fitness-for-transfusion/",
    "2bc94adaba6d0d8c754ccccce2d33eb3daf470e9c8c03d116f2c5739a5a25034",
    ["dr-robin-turner"],
  ],
  [
    "/timeline/first-tree-genome-decoded/",
    "69725dfee2d6bab4d3c64172d229a1341003dab4b788fd88c0dc4992c1dd10bb",
    ["dr-brian-ellis"],
  ],
  [
    "/timeline/hemorhage-bleeding-is-the-leading-killer-of-humans/",
    "ad5f5e1c211a98c2312cca33bd657145e0036f339af5c54966d0a5da60d4ce37",
    ["dr-christian-kastrup"],
  ],
  [
    "/timeline/process-analytical-technologies-pat-for-raman-spectroscopy-developed/",
    "3bca16d95854a6abd27f5bc5e67421fee6f99f765af6b33752492ee6f2b3eb62",
    ["dr-robin-turner"],
  ],
  [
    "/timeline/prominent-scientists-and-engineers-recruited-to-the-biotechnology-lab/",
    "4b9cb76af2179a9ed826758fb601b1462df26eb160c8e41155d8a70bc2121e27",
    ["dr-robin-turner"],
  ],
  [
    "/timeline/the-michael-smith-laboratories-gain-three-new-researchers/",
    "145ce47ade420a8da834ddee4eccab2e8d949919e2f788bc427a4180ec0ce6cf",
    ["dr-christian-kastrup"],
  ],
  [
    "/tracing-the-events-that-turned-a-beneficial-plant-associated-bacterium-into-a-pathogen/",
    "5dd8a7916a173fcdea2c2749e7a3236d5ac3f5ce23ad741d0d31d5c80e2616fd",
    ["dr-cara-haney"],
  ],
  [
    "/watching-wood-grow-a-recent-nature-paper/",
    "3ee949ddbd55a359ba5e7f64c1882e9a485c4c9a2cbe0d08ae11ea3a0cffb702",
    ["dr-stephen-withers"],
  ],
  [
    "/when-severe-bleeding-strikes-a-particle-propels-into-action-qa-with-dr-christian-kastrup/",
    "cd2aa3dfe22342cb1377b3789d7bc497a62dd6145dd4b642d1bd9436aac4665c",
    ["dr-christian-kastrup"],
  ],
];

const digest = (observation: Observation) =>
  createHash("sha256").update(JSON.stringify(observation.snapshot)).digest("hex");
const normalized = (value: string) => value.replace(/\s+/g, " ").trim();

export function discoverReviewedMslUnavailableLinks(
  observation: Observation,
  value: string,
  witnesses: readonly MslCitationWitness[] = reviewedMslCitationSources,
): string[] {
  if (
    value !== hostname ||
    observation.snapshot.status !== 200 ||
    observation.snapshot.requested_url !== observation.snapshot.url
  )
    return [];
  const sourceUrl = hostUrl(observation.snapshot.url, hostname);
  const snapshotSha = digest(observation);
  const $ = load(observation.snapshot.body);
  const found = new Set<string>();
  for (const [path, expectedSha, targets] of witnesses) {
    if (sourceUrl !== `${origin}${path}` || snapshotSha !== expectedSha) continue;
    for (const slug of targets) {
      if (!Object.hasOwn(labels, slug)) throw new Error("Unknown reviewed MSL profile target");
      const target = `${origin}/people/${slug}/`;
      const matches = $("a[href]")
        .toArray()
        .filter((node) => {
          try {
            return hostUrl($(node).attr("href")!, hostname, sourceUrl) === target;
          } catch {
            return false;
          }
        });
      if (!matches.length) throw new Error("Reviewed MSL unavailable citation is missing");
      for (const node of matches) {
        const anchor = $(node);
        const text = normalized(anchor.text());
        const parent = anchor.parent().prop("tagName")?.toLowerCase();
        if (!["p", "span", "li", "h2"].includes(parent ?? ""))
          throw new Error("Reviewed MSL unavailable citation context changed");
        if (!text) {
          const image = anchor.children("img");
          if (
            path !== "/people/associate-members/" ||
            slug !== "dr-stephen-withers" ||
            image.length !== 1 ||
            anchor.children().length !== 1 ||
            !image.hasClass("wp-image-10531") ||
            image.attr("src") !== `${origin}/wp-content/uploads/2018/10/Stephen_Withers-head-shot_crop.jpg`
          )
            throw new Error("Reviewed MSL unavailable citation context changed");
        } else if (!labels[slug]!.includes(text)) {
          throw new Error("Reviewed MSL unavailable citation label changed");
        }
      }
      found.add(target);
    }
  }
  return [...found].sort();
}
