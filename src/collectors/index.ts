/** Every collector that knows how to gather one group of UBC data.
 *
 * Importing this module registers all collectors in `REGISTRY`; `update.ts`
 * drives them from there. To add a source, drop a module in this directory
 * with a `register()`ed `CollectorDescriptor` and add it to the imports.
 *
 * `admissionreqs` and `holidays` are not listed: they register no collector of
 * their own and are pulled in by `admissions` and `services`.
 */

// Imported for their registration side effects; order sets the default run order.
import "./geospatial.ts";
import "./grades.ts";
import "./courses.ts";
import "./academic-calendar.ts";
import "./learning-spaces.ts";
import "./room-bookings.ts";
import "./events.ts";
import "./admissions.ts"; // also imports ./admissionreqs.ts
import "./finances.ts";
import "./people.ts";
import "./services.ts"; // also imports ./holidays.ts
import "./reports.ts";
import "./support.ts";
import "./policies.ts";
import "./housing.ts";
import "./libraries.ts";

export { CAMPUS_CHOICES, DATA_DIR, REGISTRY, setCampus, utcnow } from "../base.ts";
export type { CollectorClass } from "../base.ts";
export { Http } from "../base.ts";
export { Output } from "../base.ts";
export { wants } from "../base.ts";
