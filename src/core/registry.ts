import { InvalidValueError, type Http } from "./http.ts";
import type { Output } from "./output.ts";

/** One logical group of UBC data, registered with `register()`. */
export interface CollectorDescriptor {
  name: string;
  folder: string;
  title: string;
  description: string;
  sources: readonly string[];
  collect(http: Http, out: Output): Promise<void>;
}

export type CollectorClass = new () => CollectorDescriptor;

export const REGISTRY: Record<string, CollectorClass> = {};

export function register<T extends CollectorClass>(cls: T): T {
  const instance = new cls();
  if (!instance.name) throw new InvalidValueError(`${cls.name} needs a name`);
  REGISTRY[instance.name] = cls;
  return cls;
}
