import { Hono } from "hono";
import type { AppEnv } from "../auth";
import { requireAuth } from "../auth";
import { getFile } from "../db";
import { withEdgeCache } from "../edge-cache";
import { NotFound } from "../errors";
import { fileKey } from "../storage";

const METADATA_SUFFIX = ".metadata";

export const fileRoutes = new Hono<AppEnv>({ strict: false });

fileRoutes.use("*", requireAuth("read"));

// Serves both the distribution file and its PEP 658 "<file>.metadata" companion.
// requireAuth above runs first on every request, so an edge-cache hit never
// bypasses access control.
fileRoutes.get("/:project/:filename", (c) => {
  return withEdgeCache(c.req.raw, c.env, c.executionCtx, async () => {
    const project = c.req.param("project");
    const requested = c.req.param("filename");

    const wantsMetadata = requested.endsWith(METADATA_SUFFIX);
    const filename = wantsMetadata ? requested.slice(0, -METADATA_SUFFIX.length) : requested;

    const row = await getFile(c.env.DB, filename);
    if (!row || row.project !== project) throw new NotFound(`File '${requested}'`);
    if (wantsMetadata && row.metadata_sha256 === null) throw new NotFound(`File '${requested}'`);

    const object = await c.env.PACKAGES.get(fileKey(project, requested));
    if (!object) throw new NotFound(`File '${requested}'`);

    return new Response(object.body, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(object.size),
        ETag: object.httpEtag,
      },
    });
  });
});
