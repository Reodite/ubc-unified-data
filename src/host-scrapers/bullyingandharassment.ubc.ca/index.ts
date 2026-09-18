import { defineWordpressHost } from "../../host-crawl/adapters/wordpress-page.ts";
import type { HostScraper } from "../../host-crawl/contracts.ts";

const HOME = "https://bullyingandharassment.ubc.ca/";
const UNIT = "Bullying and Harassment Prevention at UBC";
const CONTENT = "#content > .hentry > .entry-content";
const text = (value: string) => value.replace(/\s+/g, " ").trim();
const matches = (value: string, clauses: RegExp[]) => clauses.every((clause) => clause.test(value));

const base = defineWordpressHost({
  hostname: "bullyingandharassment.ubc.ca",
  title: UNIT,
  scope:
    "Public UBC workplace bullying and harassment definitions, reporting, supervisor procedures, training and resources for faculty, staff and student employees.",
  selectors: [CONTENT],
  officialHomepage($, snapshot) {
    const wordmark = $("#ubc7-header #ubc7-wordmark a").first();
    const unit = $("#ubc7-unit-name a").first();
    if (
      text(wordmark.text()) !== "The University of British Columbia" ||
      new URL(wordmark.attr("href") ?? "", snapshot.url).href !== "https://www.ubc.ca/" ||
      text(unit.find("#ubc7-unit-identifier").text()) !== UNIT ||
      !unit.attr("href") ||
      new URL(unit.attr("href") ?? "", snapshot.url).href !== HOME ||
      text($("#ubc7-footer #ubc7-address-unit-name").text()) !== "Human Resources"
    )
      return false;

    const content = $(CONTENT).clone();
    // Links, labels and chrome cannot supply procedure evidence; extraction retains the original prose.
    content
      .find(
        "a,h1,h2,h3,h4,h5,h6,nav,header,footer,aside,script,style,noscript,template,form,[role=navigation],[hidden],[aria-hidden=true],.site-header,.site-footer,.entry-meta,.entry-utility",
      )
      .remove();
    return content
      .children(".frontpage")
      .toArray()
      .some((frontpage) => {
        const front = $(frontpage);
        const paragraphs = front
          .children("p")
          .toArray()
          .map((paragraph) => text($(paragraph).text()));
        if (
          !paragraphs.some((paragraph) =>
            matches(paragraph, [
              /At UBC, we strive to provide a safe, respectful and productive work environment/i,
              /faculty, staff and student employees/i,
            ]),
          ) ||
          !paragraphs.some((paragraph) =>
            matches(paragraph, [
              /Bullying or harassment is objectionable and unwanted behaviour/i,
              /without reasonable justification/i,
              /creates a hostile or intimidating environment for working, learning or living/i,
            ]),
          )
        )
          return false;

        return front
          .children(".row-fluid")
          .toArray()
          .some((row) => {
            const columns = $(row).children(".span6");
            const reporting = columns.children("div").filter((_, element) =>
              $(element)
                .children("p")
                .toArray()
                .some((paragraph) =>
                  /If you feel you have been bullied or harassed at work/i.test(text($(paragraph).text())),
                ),
            );
            const hasReporting = reporting.toArray().some((element) => {
              const procedure = $(element);
              const paired = (condition: RegExp, steps: RegExp[][]) =>
                procedure
                  .children("p")
                  .toArray()
                  .some((paragraph) => {
                    const label = $(paragraph);
                    const list = label.next("ul");
                    const items = list
                      .add(list.next("ul"))
                      .children("li")
                      .toArray()
                      .map((item) => text($(item).text()));
                    return (
                      condition.test(text(label.text())) &&
                      steps.every((clauses, index) => matches(items[index] ?? "", clauses))
                    );
                  });
              const prose = procedure
                .children("p")
                .toArray()
                .map((paragraph) => text($(paragraph).text()));
              return (
                paired(
                  /If you are a faculty or staff member \(including students who are employed by the University\)/i,
                  [
                    [
                      /If you feel comfortable doing so, calmly approach the alleged harasser/i,
                      /offensive and unwelcome/i,
                      /insist that they stop immediately/i,
                    ],
                  ],
                ) &&
                paired(
                  /If you are not comfortable approaching the alleged bully or if the unwelcome behaviour continues/i,
                  [
                    [/Contact your immediate supervisor or manager to report/i],
                    [
                      /If you feel that no action has been taken at the management level/i,
                      /contact the HR advisor to initiate an investigation/i,
                    ],
                  ],
                ) &&
                paired(/If the employer or supervisor is the alleged harasser/i, [
                  [
                    /Contact your administrative head of unit, Union\/Association representative/i,
                    /Human Resources Advisor for the Vancouver campus/i,
                    /Director of HR for the Okanagan campus/i,
                  ],
                ]) &&
                paired(/If you observe one of your co-workers being bullied and harassed at work/i, [
                  [
                    /Report what you have observed to your immediate supervisor or the administrative head of your unit/i,
                  ],
                  [
                    /If your employer or supervisor is the alleged harasser/i,
                    /report to your administrative head of unit, Union\/Association representative/i,
                    /Human Resources Advisor for the Vancouver campus/i,
                    /Director of HR for the Okanagan campus/i,
                  ],
                ]) &&
                prose.some((paragraph) =>
                  matches(paragraph, [
                    /keep a journal of each incident/i,
                    /time, date, location, and a brief description/i,
                    /names of those who directly observed each incident/i,
                  ]),
                )
              );
            });
            const hasSupervisor = columns.toArray().some((element) => {
              const column = $(element);
              const label = column
                .children("p")
                .filter((_, paragraph) =>
                  /Supervisors or managers receiving a complaint should follow the following procedure/i.test(
                    text($(paragraph).text()),
                  ),
                );
              const steps = label
                .next("ul")
                .children("li")
                .toArray()
                .map((item) => text($(item).text()));
              return [
                [
                  /Listen to the complainant and take the information presented seriously/i,
                  /Acknowledge the difficulties bringing such a complaint forward/i,
                ],
                [/If you are not at the management level, bring the complaint forward to your manager/i],
                [
                  /Investigations of complaints must be conducted at a management level/i,
                  /guidance from Human Resources or Faculty Relations/i,
                ],
                [
                  /utmost confidentiality to the extent possible/i,
                  /retaliatory action for filing a complaint will not be tolerated/i,
                ],
                [
                  /Ask the complainant to describe what happened in detailed, chronological order/i,
                  /What led to the complaint\?/,
                  /What behaviour does the complainant consider harassing or bullying\?/,
                  /Did this behaviour occur more than once\?/,
                  /Has this happened to anybody else\?/,
                  /If the complaint was not filed right away, what were the reasons for delay\?/,
                  /How has the behaviour affected you\?/,
                  /What does resolution look like\?/,
                  /Is there anything else I need to know\?/,
                ],
                [
                  /Take careful notes and identify areas requiring further clarity/i,
                  /Ask the complainant to check your notes/i,
                  /In some cases, it may be advisable/i,
                  /submit their complaint in writing/i,
                ],
                [/Offer support resources information to the employee/i],
                [/Investigation lead must follow-up with affected employee regarding the investigation/i],
                [/Corrective actions should be developed and implemented to prevent future incidents/i],
              ].every((clauses, index) => matches(steps[index] ?? "", clauses));
            });
            return hasReporting && hasSupervisor;
          });
      });
  },
});

export const bullyingAndHarassmentScraper: HostScraper = {
  ...base,
  adapter: { ...base.adapter, apiContentFallback: true },
};
