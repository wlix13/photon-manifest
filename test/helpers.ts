import { SELF } from "cloudflare:test";
import { strToU8, zipSync } from "fflate";

export const BASE = "https://registry.test";

/** Basic Authorization header value for a username/password pair. */
export function basicAuth(username: string, password: string): string {
  return "Basic " + btoa(`${username}:${password}`);
}

/** The bootstrap admin configured in test/wrangler.test.jsonc. */
export const ADMIN = basicAuth("admin", "admin-password");

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Builds a minimal but structurally valid wheel for `distribution` (underscored), `summary` varies the bytes. */
export function buildWheel(
  distribution: string,
  version: string,
  summary = "",
): { filename: string; bytes: Uint8Array } {
  const distInfo = `${distribution}-${version}.dist-info`;
  const bytes = zipSync({
    [`${distribution}/__init__.py`]: strToU8(""),
    [`${distInfo}/METADATA`]: strToU8(
      `Metadata-Version: 2.1\nName: ${distribution}\nVersion: ${version}\n` +
        (summary ? `Summary: ${summary}\n` : ""),
    ),
    [`${distInfo}/WHEEL`]: strToU8("Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n"),
    [`${distInfo}/RECORD`]: strToU8(""),
  });
  return { filename: `${distribution}-${version}-py3-none-any.whl`, bytes };
}

/** Posts a file to /legacy/ the way twine does; `overrides` replace form fields. */
export async function uploadFile(
  authHeader: string,
  file: { filename: string; bytes: Uint8Array },
  fields: { name: string; version: string },
  overrides: Record<string, string> = {},
): Promise<Response> {
  const form = new FormData();
  form.set(":action", "file_upload");
  form.set("protocol_version", "1");
  form.set("name", fields.name);
  form.set("version", fields.version);
  form.set("filetype", file.filename.endsWith(".whl") ? "bdist_wheel" : "sdist");
  form.set("sha256_digest", await sha256Hex(file.bytes));
  for (const [key, value] of Object.entries(overrides)) form.set(key, value);
  form.set("content", new File([file.bytes], file.filename));
  return SELF.fetch(`${BASE}/legacy/`, {
    method: "POST",
    body: form,
    headers: { Authorization: authHeader },
  });
}

/** GET with optional auth/accept headers. */
export async function get(
  path: string,
  options: { auth?: string; accept?: string; redirect?: "follow" | "manual" } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.auth) headers["Authorization"] = options.auth;
  if (options.accept) headers["Accept"] = options.accept;
  return SELF.fetch(`${BASE}${path}`, { headers, redirect: options.redirect ?? "follow" });
}

/** JSON request helper for the /api endpoints. */
export async function api(
  method: string,
  path: string,
  auth: string,
  body?: unknown,
): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: auth,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
