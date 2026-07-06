import { Hono } from "hono";
import type { AppEnv, AuthContext } from "../auth";
import {
  TOKEN_USERNAME,
  assertProjectAccess,
  generateToken,
  hashPassword,
  requireAuth,
} from "../auth";
import type { Role } from "../db";
import {
  createUser,
  deleteFileRow,
  deleteProjectRows,
  deleteToken,
  deleteUser,
  filesByProject,
  getFile,
  getUser,
  insertToken,
  listProjectSummaries,
  listTokens,
  listUsers,
  setYanked,
  updatePassword,
} from "../db";
import { pbkdf2Iterations } from "../env";
import { BadRequest, Forbidden, NotFound } from "../errors";
import { purgeCachedFile } from "../edge-cache";
import { isValidProjectName, normalizeName } from "../names";
import { deleteFileObjects } from "../storage";

const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ROLES: readonly Role[] = ["read", "write", "admin"];
const MIN_PASSWORD_LENGTH = 8;

export const adminRoutes = new Hono<AppEnv>({ strict: false });

/** Parses the request body as a JSON object, or fails with 400. */
async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw new BadRequest("Expected a JSON object body.");
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new BadRequest(`Field '${key}' must be a string.`);
  return value;
}

function requireStringField(body: Record<string, unknown>, key: string): string {
  const value = stringField(body, key);
  if (value === undefined || value === "") throw new BadRequest(`Field '${key}' is required.`);
  return value;
}

function validatePassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new BadRequest(`Passwords must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
}

// --- identity ---------------------------------------------------------------

adminRoutes.get("/whoami", requireAuth("read"), (c) => c.json(c.get("auth")));

// --- users (admin only) -----------------------------------------------------

adminRoutes.get("/users", requireAuth("admin"), async (c) => {
  return c.json(await listUsers(c.env.DB));
});

adminRoutes.post("/users", requireAuth("admin"), async (c) => {
  const body = await readJson(c.req.raw);
  const username = requireStringField(body, "username");
  const password = requireStringField(body, "password");
  const role = requireStringField(body, "role") as Role;

  if (!USERNAME_RE.test(username) || username === TOKEN_USERNAME) {
    throw new BadRequest(`Invalid username '${username}'.`);
  }
  if (username === c.env.ADMIN_USERNAME) {
    throw new BadRequest("This username is reserved for the bootstrap admin.");
  }
  if (!ROLES.includes(role)) throw new BadRequest("Role must be one of read, write, admin.");
  validatePassword(password);

  const passwordHash = await hashPassword(password, pbkdf2Iterations(c.env));
  await createUser(c.env.DB, { username, passwordHash, role });
  return c.json({ username, role }, 201);
});

adminRoutes.delete("/users/:username", requireAuth("admin"), async (c) => {
  const username = c.req.param("username");
  if (!(await deleteUser(c.env.DB, username))) throw new NotFound(`User '${username}'`);
  return c.json({ deleted: username });
});

adminRoutes.put("/users/:username/password", requireAuth("read"), async (c) => {
  const auth = c.get("auth");
  const username = c.req.param("username");
  const isSelf = auth.username === username && !auth.viaToken;
  if (!isSelf && auth.role !== "admin") {
    throw new Forbidden("Only admins may change other users' passwords.");
  }

  const body = await readJson(c.req.raw);
  const password = requireStringField(body, "password");
  validatePassword(password);

  const passwordHash = await hashPassword(password, pbkdf2Iterations(c.env));
  if (!(await updatePassword(c.env.DB, username, passwordHash))) {
    throw new NotFound(`User '${username}'`);
  }
  return c.json({ updated: username });
});

// --- tokens -----------------------------------------------------------------

/** Owner of a new token: self by default, anyone for admins. */
async function resolveTokenOwner(
  c: { env: AppEnv["Bindings"] },
  auth: AuthContext,
  requested: string | undefined,
): Promise<{ username: string; role: Role }> {
  const username = requested ?? auth.username;
  if (username !== auth.username && auth.role !== "admin") {
    throw new Forbidden("Only admins may create tokens for other users.");
  }
  const user = await getUser(c.env.DB, username);
  if (!user) {
    throw new BadRequest(
      `Tokens can only belong to database users; '${username}' is not one. ` +
        "(The bootstrap admin should create a database user first.)",
    );
  }
  return { username: user.username, role: user.role };
}

adminRoutes.post("/tokens", requireAuth("read"), async (c) => {
  const auth = c.get("auth");
  if (auth.viaToken) {
    throw new Forbidden("Tokens cannot create tokens; authenticate with a password.");
  }

  const body = await readJson(c.req.raw);
  const name = requireStringField(body, "name");
  const owner = await resolveTokenOwner(c, auth, stringField(body, "username"));

  const role = (stringField(body, "role") ?? "write") as "read" | "write";
  if (role !== "read" && role !== "write") throw new BadRequest("Token role must be read or write.");
  if (role === "write" && owner.role === "read") {
    throw new BadRequest(`User '${owner.username}' only has the read role.`);
  }

  const projectRaw = stringField(body, "project");
  if (projectRaw !== undefined && !isValidProjectName(projectRaw)) {
    throw new BadRequest(`Invalid project name '${projectRaw}'.`);
  }
  const project = projectRaw !== undefined ? normalizeName(projectRaw) : null;

  let expiresAt: string | null = null;
  const expiresInDays = body["expires_in_days"];
  if (expiresInDays !== undefined) {
    if (typeof expiresInDays !== "number" || !Number.isFinite(expiresInDays) || expiresInDays <= 0) {
      throw new BadRequest("Field 'expires_in_days' must be a positive number.");
    }
    expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  }

  const { token, tokenHash } = await generateToken();
  const id = crypto.randomUUID();
  await insertToken(c.env.DB, {
    id,
    tokenHash,
    username: owner.username,
    name,
    role,
    project,
    expiresAt,
  });

  // The plaintext token is returned exactly once and never stored.
  return c.json({ id, token, username: owner.username, name, role, project, expires_at: expiresAt }, 201);
});

adminRoutes.get("/tokens", requireAuth("read"), async (c) => {
  const auth = c.get("auth");
  if (auth.role === "admin") {
    return c.json(await listTokens(c.env.DB, c.req.query("username")));
  }
  return c.json(await listTokens(c.env.DB, auth.username));
});

adminRoutes.delete("/tokens/:id", requireAuth("read"), async (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  const owner = auth.role === "admin" ? undefined : auth.username;
  if (!(await deleteToken(c.env.DB, id, owner))) throw new NotFound(`Token '${id}'`);
  return c.json({ deleted: id });
});

// --- projects and files -----------------------------------------------------

adminRoutes.get("/projects", requireAuth("read"), async (c) => {
  return c.json(await listProjectSummaries(c.env.DB));
});

adminRoutes.get("/projects/:name", requireAuth("read"), async (c) => {
  const project = normalizeName(c.req.param("name"));
  const files = await filesByProject(c.env.DB, project);
  if (files.length === 0) throw new NotFound(`Project '${project}'`);
  return c.json({ project, files });
});

adminRoutes.delete("/projects/:name", requireAuth("admin"), async (c) => {
  const project = normalizeName(c.req.param("name"));
  const rows = await deleteProjectRows(c.env.DB, project);
  if (rows.length === 0) throw new NotFound(`Project '${project}'`);

  const requestUrl = new URL(c.req.url);
  for (const row of rows) {
    await deleteFileObjects(c.env.PACKAGES, project, row.filename);
    await purgeCachedFile(c.env, requestUrl, project, row.filename);
  }
  return c.json({ deleted: project, files: rows.length });
});

/** Loads a file row, enforcing project match and token scope. */
async function loadProjectFile(
  c: { env: AppEnv["Bindings"] },
  auth: AuthContext,
  rawProject: string,
  filename: string,
): Promise<{ project: string; filename: string }> {
  const project = normalizeName(rawProject);
  assertProjectAccess(auth, project);
  const row = await getFile(c.env.DB, filename);
  if (!row || row.project !== project) throw new NotFound(`File '${filename}'`);
  return { project, filename };
}

adminRoutes.delete("/projects/:name/files/:filename", requireAuth("write"), async (c) => {
  const auth = c.get("auth");
  const { project, filename } = await loadProjectFile(c, auth, c.req.param("name"), c.req.param("filename"));
  await deleteFileRow(c.env.DB, filename);
  await deleteFileObjects(c.env.PACKAGES, project, filename);
  await purgeCachedFile(c.env, new URL(c.req.url), project, filename);
  return c.json({ deleted: filename });
});

adminRoutes.post("/projects/:name/files/:filename/yank", requireAuth("write"), async (c) => {
  const auth = c.get("auth");
  const { filename } = await loadProjectFile(c, auth, c.req.param("name"), c.req.param("filename"));
  const body = await readJson(c.req.raw).catch(() => ({}) as Record<string, unknown>);
  await setYanked(c.env.DB, filename, true, stringField(body, "reason") ?? null);
  return c.json({ yanked: filename });
});

adminRoutes.post("/projects/:name/files/:filename/unyank", requireAuth("write"), async (c) => {
  const auth = c.get("auth");
  const { filename } = await loadProjectFile(c, auth, c.req.param("name"), c.req.param("filename"));
  await setYanked(c.env.DB, filename, false, null);
  return c.json({ unyanked: filename });
});
