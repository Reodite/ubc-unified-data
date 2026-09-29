import { describe, expect, it } from "vitest";
import { assertPublishableArticle } from "./article-quality.ts";

const popParagraphs = [
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Quisque vitae ullamcorper dolor, vel imperdiet ante. Cras maximus a ex a hendrerit. Suspendisse viverra metus ultrices tortor congue facilisis. Sed bibendum, neque ut dignissim imperdiet, nulla odio iaculis ipsum, ac ultrices massa nulla quis justo. Sed at massa ut libero suscipit porttitor. Mauris tempor nisl eros, ut ultrices mauris commodo sit amet. Sed vel enim ut lorem accumsan porta. Sed finibus felis vitae libero mattis, a pharetra felis consectetur. Morbi suscipit luctus molestie. Nunc eu ex in ligula auctor tristique et ut odio. Nulla mattis leo vel aliquet molestie. Aliquam in fringilla tellus. Sed neque libero, molestie ut erat quis, fringilla tristique velit. Nullam maximus felis vel ante cursus, ac tempus magna gravida. Vivamus at libero aliquet orci iaculis pellentesque in ac turpis.",
  "Ut euismod bibendum hendrerit. Orci varius natoque penatibus et magnis dis parturient montes, nascetur ridiculus mus. Phasellus mollis at turpis sed fermentum. Vestibulum vehicula est sed massa laoreet, vitae molestie ante volutpat. Aenean nec eros cursus, accumsan est vel, eleifend risus. Phasellus velit libero, laoreet ut volutpat a, sodales id risus. Proin eu cursus ante. Vestibulum lectus enim, venenatis eget ultrices quis, ultricies vitae neque. Donec mattis dictum nisi in tempor. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed elit elit, mattis ac erat facilisis, elementum posuere sem. Aliquam vel arcu non justo aliquam facilisis eget a lacus.",
  "Maecenas vestibulum mauris sit amet odio pellentesque, sed vulputate odio pretium. Quisque nulla urna, fermentum rhoncus gravida ac, tristique et nunc. In ac leo vel sem interdum luctus. Maecenas nec neque dapibus, rutrum ante quis, fringilla quam. Quisque eget tincidunt ex, vitae scelerisque felis. Suspendisse potenti. Suspendisse sed sapien sed neque posuere elementum volutpat at arcu. Vivamus id libero eget libero elementum vestibulum. Nulla facilisi. Aliquam maximus erat a consequat molestie. Aliquam sit amet elit vestibulum odio viverra molestie ac et lacus. Vestibulum facilisis nisl sollicitudin ullamcorper tempus.",
];
const newsImage =
  "[Image](https://phh-comicstudies-2024.sites.olt.ubc.ca/files/2020/05/Home-Banner-Placeholder-01-300x169.jpg)";
const postImage =
  "[Image](https://phh-comicstudies-2024.sites.olt.ubc.ca/files/2021/09/Post-and-Page-Placeholder-300x134.jpg)";
const templates = [
  { name: "pop-culture news", body: [popParagraphs[0], newsImage, ...popParagraphs.slice(1)].join("\n\n") },
  {
    name: "pop-culture staff",
    body: [postImage, "### Position Title", "### \\(Pronouns\\)", ...popParagraphs.slice(0, 2)].join("\n\n"),
  },
  {
    name: "pop-culture blog",
    body: ["By ohhchen on May 03, 2025", popParagraphs[0], postImage, ...popParagraphs.slice(1)].join("\n\n"),
  },
  {
    name: "unitedway Lorem",
    body: [
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam ornare, odio eget vehicula venenatis, arcu massa condimentum erat, id sollicitudin nisi libero quis sapien. Maecenas luctus efficitur quam, vitae eleifend diam. Aliquam vel ante enim. Quisque sed diam eget odio commodo semper. Integer pharetra sapien vel ullamcorper euismod. Duis sagittis ante varius turpis efficitur, id ultrices justo fringilla. Ut id elementum lorem, porttitor mollis ante. Vivamus volutpat tellus at lacus gravida tincidunt. Nullam consequat velit ac justo finibus lacinia. Aenean quam libero, rhoncus ac dapibus a, vestibulum eget nibh. Sed sodales in erat sed placerat. Quisque scelerisque ligula neque, non efficitur leo blandit nec. Proin sed sodales felis.",
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Suspendisse bibendum maximus ultrices. Nam ante elit, blandit non ullamcorper ac, molestie ac diam. Nam dictum dui non leo pellentesque volutpat. Vivamus enim magna, sodales non sapien sit amet, ultricies mollis nibh. Aliquam ac sollicitudin elit, nec congue neque. Morbi non purus eu enim rhoncus volutpat.",
      "Quisque tincidunt interdum nibh, in finibus est. Maecenas ultricies tincidunt metus, ac hendrerit tortor aliquet et. Nullam eget maximus nisi. Nulla mi odio, porta vel eleifend eget, cursus eget tellus. Aenean ullamcorper tortor lorem, in pellentesque dui aliquam in. Donec commodo, lorem in commodo accumsan, ante dolor tristique turpis, vitae volutpat ante sapien eget dui. Vestibulum accumsan varius sem, vitae pharetra mi blandit nec. Morbi vitae ligula vitae libero ullamcorper ultricies. Vivamus ullamcorper rutrum eros, ac finibus neque condimentum a. Proin id convallis erat, sit amet placerat velit. Maecenas a venenatis libero, eget vehicula purus. Vivamus vel lectus in massa commodo aliquam. Nullam id turpis scelerisque, lacinia libero eget, finibus massa.",
      "Curabitur gravida erat nisi, ut vehicula erat suscipit vel. Vestibulum tempus sem in dapibus feugiat. Sed ut pretium mi. Donec ex ligula, commodo quis erat eget, varius convallis sapien. Phasellus eget commodo leo. Vivamus venenatis fringilla velit, in vestibulum orci bibendum at. Nullam mattis, justo et gravida sagittis, nulla mauris finibus felis, nec ultrices libero leo vel nisi. Donec congue nisi consectetur tempor venenatis. Proin ultricies porttitor arcu, luctus condimentum mi porttitor vel. Quisque tincidunt vulputate felis nec porta. Etiam sed mi maximus tortor euismod rhoncus. Vestibulum porta pharetra tortor. Aliquam nisl augue, lobortis eu rhoncus quis, sollicitudin in lorem. Mauris mollis, justo in interdum porttitor, lacus augue laoreet neque, ut efficitur ligula sapien nec eros. In posuere vestibulum quam, at imperdiet sapien varius in.",
      "Donec pretium nisi vitae elit lacinia, ac pharetra neque hendrerit. Etiam libero metus, vehicula eget scelerisque vel, hendrerit non massa. In hac habitasse platea dictumst. Vivamus faucibus nunc at tempor mollis. Nam tempor urna ac velit porta, vel ultrices dolor hendrerit. Vivamus posuere ullamcorper congue. Nullam vel auctor est. Maecenas lobortis, leo mollis molestie varius, ex purus scelerisque tellus, a pretium purus magna non nunc. Etiam at gravida lorem. In finibus pretium turpis, vel efficitur erat convallis sed. Pellentesque tristique dui at nulla sodales, quis tincidunt ante laoreet. Duis in justo et tortor vehicula aliquet a non eros. Praesent sed eros porta, aliquet dui vitae, mattis justo. Nulla elementum, ex eget placerat aliquet, enim lorem semper sem, sed cursus magna ante at tellus. Fusce aliquet, metus in sodales dictum, augue lectus consequat purus, quis pellentesque lorem massa a ex. Curabitur vestibulum lorem nec nunc pretium tincidunt.",
    ].join("\n\n"),
  },
];

describe("complete observed template fingerprints", () => {
  it.each(templates)("rejects only the complete $name template", ({ body }) => {
    const source_url = "https://fixture.ubc.ca/template/";
    for (const content_markdown of [body, body.replaceAll(".", "\\."), `\n ${body.replaceAll("\n", "\t")} \n`]) {
      const document = Object.freeze({ source_url, content_markdown });
      expect(() => assertPublishableArticle(document)).toThrow(/known placeholder/);
      expect(document.content_markdown).toBe(content_markdown);
    }
    for (const content_markdown of [
      `This guide explains how to replace the following sample content.\n\n${body}`,
      `${body}\n\nThe application deadline is Friday.`,
      body.replace("Lorem ipsum dolor sit amet", "The source records describe the registration process"),
    ])
      expect(() => assertPublishableArticle({ source_url, content_markdown })).not.toThrow();
  });
});
