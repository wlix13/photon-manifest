import type { FileRow } from "./db";

export const SIMPLE_JSON = "application/vnd.pypi.simple.v1+json";
export const SIMPLE_HTML = "application/vnd.pypi.simple.v1+html";

/** Picks the response flavor from the Accept header (PEP 691 negotiation). */
export function preferredFormat(accept: string | null): "json" | "html" {
  if (!accept) return "html";
  let best: { format: "json" | "html"; q: number } | null = null;
  for (const part of accept.split(",")) {
    const [rawType = "", ...params] = part.trim().split(";");
    const type = rawType.trim().toLowerCase();
    let q = 1;
    for (const param of params) {
      const [key, value] = param.split("=").map((s) => s.trim());
      if (key === "q" && value) q = Number(value) || 0;
    }
    let format: "json" | "html" | null = null;
    if (type === SIMPLE_JSON) format = "json";
    else if (type === SIMPLE_HTML || type === "text/html") format = "html";
    else if (type === "*/*" || type === "text/*" || type === "application/*") format = "html";
    if (format !== null && q > 0 && (best === null || q > best.q)) best = { format, q };
  }
  return best?.format ?? "html";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fileUrl(baseUrl: string, file: FileRow): string {
  return `${baseUrl}/files/${file.project}/${file.filename}`;
}

/** PEP 503 root index: one anchor per project. */
export function renderIndexHtml(projects: string[]): string {
  const anchors = projects
    .map((name) => `    <a href="/simple/${name}/">${escapeHtml(name)}</a><br />`)
    .join("\n");
  return `<!DOCTYPE html>
<html>
  <head>
    <meta name="pypi:repository-version" content="1.0">
    <title>Simple index</title>
  </head>
  <body>
${anchors}
  </body>
</html>
`;
}

/** PEP 691 root index (api-version 1.1). */
export function renderIndexJson(projects: string[]): unknown {
  return {
    meta: { "api-version": "1.1" },
    projects: projects.map((name) => ({ name })),
  };
}

/** Anchor attributes carrying PEP 592 (yank) and PEP 658/714 (metadata) data. */
function fileAttributes(file: FileRow): string {
  let attrs = "";
  if (file.requires_python !== null && file.requires_python !== "") {
    attrs += ` data-requires-python="${escapeHtml(file.requires_python)}"`;
  }
  if (file.yanked) {
    attrs += ` data-yanked="${escapeHtml(file.yanked_reason ?? "")}"`;
  }
  if (file.metadata_sha256 !== null) {
    attrs += ` data-core-metadata="sha256=${file.metadata_sha256}"`;
    attrs += ` data-dist-info-metadata="sha256=${file.metadata_sha256}"`;
  }
  return attrs;
}

/** PEP 503 project page: one anchor per file with a sha256 fragment. */
export function renderProjectHtml(project: string, files: FileRow[], baseUrl: string): string {
  const anchors = files
    .map((file) => {
      const href = `${fileUrl(baseUrl, file)}#sha256=${file.sha256}`;
      return `    <a href="${href}"${fileAttributes(file)}>${escapeHtml(file.filename)}</a><br />`;
    })
    .join("\n");
  return `<!DOCTYPE html>
<html>
  <head>
    <meta name="pypi:repository-version" content="1.0">
    <title>Links for ${escapeHtml(project)}</title>
  </head>
  <body>
    <h1>Links for ${escapeHtml(project)}</h1>
${anchors}
  </body>
</html>
`;
}

/** PEP 691 + PEP 700 project page (api-version 1.1). */
export function renderProjectJson(project: string, files: FileRow[], baseUrl: string): unknown {
  const versions = [...new Set(files.map((file) => file.version))].sort();
  return {
    meta: { "api-version": "1.1" },
    name: project,
    versions,
    files: files.map((file) => {
      const metadata = file.metadata_sha256 !== null ? { sha256: file.metadata_sha256 } : false;
      return {
        filename: file.filename,
        url: fileUrl(baseUrl, file),
        hashes: { sha256: file.sha256 },
        "requires-python": file.requires_python ?? "",
        size: file.size,
        "upload-time": file.uploaded_at,
        yanked: file.yanked ? (file.yanked_reason ?? true) : false,
        "core-metadata": metadata,
        "data-dist-info-metadata": metadata,
      };
    }),
  };
}
