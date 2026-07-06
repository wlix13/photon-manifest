import { Hono } from "hono";
import type { AppEnv } from "../auth";
import { requireAuth } from "../auth";
import { filesByProject, listProjectNames } from "../db";
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

export const simpleRoutes = new Hono<AppEnv>({ strict: false });

simpleRoutes.use("*", requireAuth("read"));

simpleRoutes.get("/", async (c) => {
  const projects = await listProjectNames(c.env.DB);
  if (preferredFormat(c.req.header("Accept") ?? null) === "json") {
    return c.body(JSON.stringify(renderIndexJson(projects)), 200, JSON_HEADERS);
  }
  return c.body(renderIndexHtml(projects), 200, HTML_HEADERS);
});

simpleRoutes.get("/:project", async (c) => {
  const requested = c.req.param("project");
  const project = normalizeName(requested);
  if (requested !== project) return c.redirect(`/simple/${project}/`, 301);

  const files = await filesByProject(c.env.DB, project);
  if (files.length === 0) throw new NotFound(`Project '${project}'`);

  const baseUrl = new URL(c.req.url).origin;
  if (preferredFormat(c.req.header("Accept") ?? null) === "json") {
    return c.body(JSON.stringify(renderProjectJson(project, files, baseUrl)), 200, JSON_HEADERS);
  }
  return c.body(renderProjectHtml(project, files, baseUrl), 200, HTML_HEADERS);
});
