import { Hono } from "hono";
import type { AppEnv } from "../auth";
import { assertProjectReadable, optionalAuth } from "../auth";
import { getFile, getProject } from "../db";
import { withEdgeCache } from "../edge-cache";
import { NotFound } from "../errors";
import { fileKey } from "../storage";
import { normalizeName } from "../names";

const METADATA_SUFFIX = ".metadata";

export const fileRoutes = new Hono<AppEnv>({ strict: false });

fileRoutes.use(optionalAuth);

// serves dist file and PEP 658 <file>.metadata companion
// gate before withEdgeCache; cache hit never bypasses access control
fileRoutes.get("/:project/:filename", async (c) => {
  const rawProject = c.req.param("project");
  const project = normalizeName(rawProject);
  const requested = c.req.param("filename");

  const auth = c.get("auth");

  const projectRow = await getProject(c.env.DB, project);
  assertProjectReadable(c.env, project, projectRow, auth);

  // cache key on normalized project, so aliases share one entry purgeCachedFile can drop
  const cacheUrl = new URL(c.req.raw.url);
  const segments = cacheUrl.pathname.split("/");
  segments[2] = project;
  cacheUrl.pathname = segments.join("/");

  const response = await withEdgeCache(new Request(cacheUrl.toString()), c.env, c.executionCtx, async () => {
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
  response.headers.set("Cache-Control", "private");
  response.headers.append("Vary", "Authorization");
  return response;
});
