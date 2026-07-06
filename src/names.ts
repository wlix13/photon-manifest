import { BadRequest } from "./errors";

/** PEP 503 name normalization: runs of ".", "-", "_" collapse to "-", lowercased. */
export function normalizeName(name: string): string {
  return name.replace(/[-_.]+/g, "-").toLowerCase();
}

/** True when `name` is a valid Python project name (PEP 508 shape). */
export function isValidProjectName(name: string): boolean {
  return /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(name);
}

const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._+!-]*$/;

/** Distribution file identity derived purely from its filename. */
export interface ParsedFilename {
  /** Normalized project name embedded in the filename. */
  project: string;
  version: string;
  filetype: "bdist_wheel" | "sdist";
}

/** Parses a wheel (PEP 427) or sdist filename; throws BadRequest for anything else. */
export function parseDistFilename(filename: string): ParsedFilename {
  if (!SAFE_FILENAME.test(filename) || filename.includes("..")) {
    throw new BadRequest(`Invalid file name '${filename}'.`);
  }
  if (filename.endsWith(".whl")) {
    // {distribution}-{version}(-{build})?-{python}-{abi}-{platform}.whl
    const parts = filename.slice(0, -4).split("-");
    if (parts.length < 5 || parts.length > 6) {
      throw new BadRequest(`'${filename}' is not a valid wheel file name.`);
    }
    const [distribution, version] = parts as [string, string, ...string[]];
    return { project: normalizeName(distribution), version, filetype: "bdist_wheel" };
  }
  if (filename.endsWith(".tar.gz")) {
    const stem = filename.slice(0, -7);
    const sep = stem.lastIndexOf("-");
    if (sep <= 0 || sep === stem.length - 1) {
      throw new BadRequest(`'${filename}' is not a valid sdist file name.`);
    }
    return {
      project: normalizeName(stem.slice(0, sep)),
      version: stem.slice(sep + 1),
      filetype: "sdist",
    };
  }
  throw new BadRequest("Only .whl and .tar.gz files are accepted.");
}

/** Lenient version equality for cross-checking form fields against filenames. */
export function versionsEquivalent(a: string, b: string): boolean {
  const canon = (v: string) => v.toLowerCase().replace(/[-_]/g, ".");
  return canon(a) === canon(b);
}
