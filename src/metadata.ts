import { Unzip, UnzipInflate } from "fflate";

const METADATA_PATH = /^[^/]+\.dist-info\/METADATA$/;

const MAX_METADATA_BYTES = 1024 * 1024; // metadata ceiling

/** Extracts `*.dist-info/METADATA` from a wheel (PEP 658), or null when absent. */
export function extractWheelMetadata(wheel: Uint8Array): Promise<Uint8Array | null> {
  let taken = false;
  let matched = false;
  const chunks: Uint8Array[] = [];
  let total = 0;
  let settled = false;

  return new Promise((resolve) => {
    try {
      const unzip = new Unzip((file) => {
        if (!METADATA_PATH.test(file.name)) return;
        if (taken) return;
        if (file.originalSize !== undefined && file.originalSize > MAX_METADATA_BYTES) {
          settled = true;
          resolve(null);
          return;
        }
        matched = true;
        taken = true;

        file.ondata = (err, chunk, final) => {
          if (err) {
            settled = true;
            resolve(null);
            return;
          }
          if (chunk) {
            total += chunk.length;
            if (total > MAX_METADATA_BYTES) {
              settled = true;
              resolve(null);
              return;
            }
            chunks.push(chunk);
          }
          if (final) {
            const out = new Uint8Array(total);
            let offset = 0;
            for (const c of chunks) {
              out.set(c, offset);
              offset += c.length;
            }
            settled = true;
            resolve(out);
          }
        };
        file.start();
      });
      unzip.register(UnzipInflate);
      const CHUNK = 64 * 1024;
      let aborted = false;
      for (let offset = 0; offset < wheel.length && !aborted && !settled; offset += CHUNK) {
        const slice = wheel.subarray(offset, Math.min(offset + CHUNK, wheel.length));
        const final = offset + CHUNK >= wheel.length;
        unzip.push(slice, final);
        if (total > MAX_METADATA_BYTES) {
          aborted = true;
        }
      }

      if (!matched) resolve(null);
    } catch {
      resolve(null);
    }
  });
}
