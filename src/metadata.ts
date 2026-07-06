import { unzipSync } from "fflate";

const METADATA_PATH = /^[^/]+\.dist-info\/METADATA$/;

/** Extracts `*.dist-info/METADATA` from a wheel (PEP 658), or null when absent. */
export function extractWheelMetadata(wheel: Uint8Array): Uint8Array | null {
  try {
    const entries = unzipSync(wheel, { filter: (file) => METADATA_PATH.test(file.name) });
    const first = Object.keys(entries)[0];
    return first !== undefined ? (entries[first] ?? null) : null;
  } catch {
    return null;
  }
}
