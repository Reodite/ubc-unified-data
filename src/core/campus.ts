import { InvalidValueError } from "./http.ts";

export const CAMPUS_CHOICES = ["vancouver", "okanagan", "both"] as const;
export type Campus = (typeof CAMPUS_CHOICES)[number];

let _selected: Campus = "vancouver";

export function setCampus(value: string): void {
  if (!(CAMPUS_CHOICES as readonly string[]).includes(value)) {
    const shown = CAMPUS_CHOICES.map((c) => `'${c}'`).join(", ");
    throw new InvalidValueError(`campus must be one of ${shown}, got '${value}'`);
  }
  _selected = value as Campus;
}

export function selectedCampus(): Campus {
  return _selected;
}

/** Keep matching campuses and all unlabelled records to avoid data loss on naming changes. */
export function wants(campus: string | null | undefined): boolean {
  if (campus === null || campus === undefined || _selected === "both") return true;
  return campus === _selected;
}
