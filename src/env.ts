/** Worker bindings and configuration variables. */
export interface Env {
  DB: D1Database;
  PACKAGES: R2Bucket;
  /** Bootstrap admin credentials (Worker secrets); this account lives outside D1. */
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  /** "true" allows unauthenticated package reads (/simple and /files). */
  PUBLIC_READ?: string;
  /** PBKDF2-SHA256 iteration count for password hashing (default 100000). */
  PBKDF2_ITERATIONS?: string;
  /** Optional upload size cap in MiB (platform caps requests at 100 MB anyway). */
  MAX_UPLOAD_MB?: string;
  /** Edge caching of downloads; "off" disables it (default on, custom domain only). */
  EDGE_CACHE?: "on" | "off";
}

/** Parses the configured PBKDF2 iteration count, falling back to the default. */
export function pbkdf2Iterations(env: Env): number {
  const parsed = Number(env.PBKDF2_ITERATIONS);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 100_000;
}
