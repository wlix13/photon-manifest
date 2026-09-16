import { Hono } from "hono";
import type { AppEnv } from "../auth";
import { assertProjectAccess, requireAuth } from "../auth";
import { deleteFileRow, getFile, insertFile } from "../db";
import { BadRequest, Conflict, HttpError } from "../errors";
import { extractWheelMetadata } from "../metadata";
import { isValidProjectName, normalizeName, parseDistFilename, versionsEquivalent } from "../names";
import { fileKey, metadataKey } from "../storage";

export const uploadRoutes = new Hono<AppEnv>({ strict: false });

uploadRoutes.use("*", requireAuth("write"));

/** Returns a non-empty string form field, or undefined. */
function field(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Legacy upload API as used by twine, uv publish, poetry publish, etc.
uploadRoutes.post("/", async (c) => {
  const auth = c.get("auth");

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw new BadRequest("Expected a multipart/form-data body.");
  }

  const action = field(form, ":action") ?? "file_upload";
  if (action !== "file_upload") throw new BadRequest(`Unsupported action '${action}'.`);

  // workers-types says string|null, but the runtime yields File for file parts.
  const content = form.get("content") as unknown;
  if (!(content instanceof File)) throw new BadRequest("Missing file field 'content'.");

  const name = field(form, "name");
  const version = field(form, "version");
  if (!name || !version) throw new BadRequest("Fields 'name' and 'version' are required.");
  if (!isValidProjectName(name)) throw new BadRequest(`Invalid project name '${name}'.`);

  const parsed = parseDistFilename(content.name);
  const project = normalizeName(name);
  if (parsed.project !== project) {
    throw new BadRequest("File name does not match the 'name' field.");
  }
  if (!versionsEquivalent(parsed.version, version)) {
    throw new BadRequest("File name does not match the 'version' field.");
  }
  const filetype = field(form, "filetype");
  if (filetype !== undefined && filetype !== parsed.filetype) {
    throw new BadRequest(`'filetype' is ${filetype} but the file looks like a ${parsed.filetype}.`);
  }
  assertProjectAccess(auth, project);

  const maxMb = Number(c.env.MAX_UPLOAD_MB);
  if (Number.isFinite(maxMb) && maxMb > 0 && content.size > maxMb * 1024 * 1024) {
    throw new HttpError(413, `File exceeds the ${maxMb} MiB upload limit.`);
  }

  const bytes = new Uint8Array(await content.arrayBuffer());
  const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
  const md5 = hex(await crypto.subtle.digest("MD5", bytes));

  const claimedSha256 = field(form, "sha256_digest")?.toLowerCase();
  const claimedMd5 = field(form, "md5_digest")?.toLowerCase();
  if (claimedSha256 !== undefined) {
    if (claimedSha256 !== sha256) throw new BadRequest("sha256_digest does not match the uploaded file.");
  } else if (claimedMd5 !== undefined) {
    if (claimedMd5 !== md5) throw new BadRequest("md5_digest does not match the uploaded file.");
  } else {
    throw new BadRequest("Provide sha256_digest (or md5_digest).");
  }

  const metadata = parsed.filetype === "bdist_wheel" ? extractWheelMetadata(bytes) : null;
  const metadataSha256 = metadata !== null ? hex(await crypto.subtle.digest("SHA-256", metadata)) : null;

  // Insert first: the filename's UNIQUE constraint is the concurrency lock,
  // so a racing duplicate upload can never overwrite stored bytes.
  try {
    await insertFile(c.env.DB, {
      filename: content.name,
      project,
      displayName: name,
      version,
      filetype: parsed.filetype,
      requiresPython: field(form, "requires_python") ?? null,
      sha256,
      md5,
      size: bytes.length,
      metadataSha256,
      uploadedBy: auth.username,
    });
  } catch (err) {
    // Identical re-upload succeeds as no-op, keeps retried publishes safe.
    if (err instanceof Conflict && (await getFile(c.env.DB, content.name))?.sha256 === sha256) {
      return c.text("");
    }
    throw err;
  }

  try {
    await c.env.PACKAGES.put(fileKey(project, content.name), bytes, {
      sha256,
      httpMetadata: { contentType: "application/octet-stream" },
    });
    if (metadata !== null) {
      await c.env.PACKAGES.put(metadataKey(project, content.name), metadata, {
        httpMetadata: { contentType: "application/octet-stream" },
      });
    }
  } catch (err) {
    await deleteFileRow(c.env.DB, content.name).catch(() => undefined);
    throw err;
  }

  return c.text("");
});
