import { Hono } from "hono";
import type { AppEnv } from "../auth";
import { assertProjectReadable, optionalAuth } from "../auth";
import { filesByProject, getProject, listProjectNames, listPublicProjectNames } from "../db";
import { NotFound } from "../errors";
import { normalizeName } from "../names";
import {
  SIMPLE_JSON,
  preferredFormat,
  renderIndexHtml,
  renderIndexJson,
  renderProjectHtml,
  renderProjectJson,
} from "../simple";

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8", Vary: "Accept" };
const JSON_HEADERS = { "Content-Type": SIMPLE_JSON, Vary: "Accept" };

export type IndexScope = "all" | "public" | "scoped";

export function indexScope(
  publicRead: boolean,
  anonymous: boolean,
  scopedProject: string | null,
): IndexScope {
  if (scopedProject !== null) return "scoped";
  if (publicRead) return "all";
  if (anonymous) return "public";
  return "all";
}

export const simpleRoutes = new Hono<AppEnv>({ strict: false });

// identity only; root filters via indexScope, project page gates via assertProjectReadable
simpleRoutes.use(optionalAuth);

simpleRoutes.get("/", async (c) => {
  const auth = c.get("auth");
  const publicRead = c.env.PUBLIC_READ === "true";
  const scope = indexScope(publicRead, auth.anonymous, auth.project);

  let projects: string[];
  if (scope === "public") {
    projects = await listPublicProjectNames(c.env.DB);
  } else if (scope === "scoped") {
    projects = (await listProjectNames(c.env.DB)).filter((name) => name === auth.project);
  } else {
    projects = await listProjectNames(c.env.DB);
  }
  if (preferredFormat(c.req.header("Accept") ?? null) === "json") {
    return c.body(JSON.stringify(renderIndexJson(projects)), 200, {
      ...JSON_HEADERS,
      "Cache-Control": "private",
      Vary: "Accept, Authorization",
    });
  }
  return c.body(renderIndexHtml(projects), 200, {
    ...HTML_HEADERS,
    "Cache-Control": "private",
    Vary: "Accept, Authorization",
  });
});

simpleRoutes.get("/:project", async (c) => {
  const requested = c.req.param("project");
  const project = normalizeName(requested);

  const auth = c.get("auth");
  const projectRow = await getProject(c.env.DB, project);
  assertProjectReadable(c.env, project, projectRow, auth);

  if (requested !== project) return c.redirect(`/simple/${project}/`, 301);

  const files = await filesByProject(c.env.DB, project);
  if (files.length === 0) throw new NotFound(`Project '${project}'`);

  const baseUrl = new URL(c.req.url).origin;
  const cacheHeaders = {
    "Cache-Control": "private",
    Vary: "Accept, Authorization",
  };
  if (preferredFormat(c.req.header("Accept") ?? null) === "json") {
    return c.body(JSON.stringify(renderProjectJson(project, files, baseUrl)), 200, {
      ...JSON_HEADERS,
      ...cacheHeaders,
    });
  }
  return c.body(renderProjectHtml(project, files, baseUrl), 200, {
    ...HTML_HEADERS,
    ...cacheHeaders,
  });
});
