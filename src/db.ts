import { Conflict } from "./errors";

/** Access level; each level includes everything below it. */
export type Role = "read" | "write" | "admin";

/** A `users` table row. */
export interface UserRow {
  username: string;
  password_hash: string;
  role: Role;
  created_at: string;
}

/** A `tokens` table row (without the stored hash). */
export interface TokenRow {
  id: string;
  username: string;
  name: string;
  role: "read" | "write";
  project: string | null;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
}

/** Token joined with its owner, as needed during authentication. */
export interface TokenAuthRow {
  id: string;
  username: string;
  token_role: "read" | "write";
  user_role: Role;
  project: string | null;
  expires_at: string | null;
}

/** A `files` table row. */
export interface FileRow {
  filename: string;
  project: string;
  display_name: string;
  version: string;
  filetype: string;
  requires_python: string | null;
  sha256: string;
  md5: string | null;
  size: number;
  metadata_sha256: string | null;
  uploaded_by: string;
  uploaded_at: string;
  yanked: number;
  yanked_reason: string | null;
}

/** Aggregate row for the project listing API. */
export interface ProjectSummary {
  project: string;
  files: number;
  versions: number;
  last_upload: string;
}

/** Rethrows D1 UNIQUE-constraint failures as a domain Conflict. */
function rethrowUnique(err: unknown, message: string): never {
  if (String(err).includes("UNIQUE constraint failed")) throw new Conflict(message);
  throw err;
}

export async function getUser(db: D1Database, username: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE username = ?").bind(username).first<UserRow>();
}

export async function listUsers(db: D1Database): Promise<Omit<UserRow, "password_hash">[]> {
  const result = await db
    .prepare("SELECT username, role, created_at FROM users ORDER BY username")
    .all<Omit<UserRow, "password_hash">>();
  return result.results;
}

export async function createUser(
  db: D1Database,
  user: { username: string; passwordHash: string; role: Role },
): Promise<void> {
  try {
    await db
      .prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)")
      .bind(user.username, user.passwordHash, user.role)
      .run();
  } catch (err) {
    rethrowUnique(err, `User '${user.username}' already exists.`);
  }
}

/** Returns false when the user does not exist. */
export async function updatePassword(
  db: D1Database,
  username: string,
  passwordHash: string,
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE users SET password_hash = ? WHERE username = ?")
    .bind(passwordHash, username)
    .run();
  return result.meta.changes > 0;
}

/** Deletes a user; their tokens go with them (ON DELETE CASCADE). */
export async function deleteUser(db: D1Database, username: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM users WHERE username = ?").bind(username).run();
  return result.meta.changes > 0;
}

export async function findTokenByHash(db: D1Database, tokenHash: string): Promise<TokenAuthRow | null> {
  return db
    .prepare(
      `SELECT t.id, t.username, t.role AS token_role, u.role AS user_role, t.project, t.expires_at
       FROM tokens t JOIN users u ON u.username = t.username
       WHERE t.token_hash = ?`,
    )
    .bind(tokenHash)
    .first<TokenAuthRow>();
}

export async function insertToken(
  db: D1Database,
  token: {
    id: string;
    tokenHash: string;
    username: string;
    name: string;
    role: "read" | "write";
    project: string | null;
    expiresAt: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tokens (id, token_hash, username, name, role, project, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(token.id, token.tokenHash, token.username, token.name, token.role, token.project, token.expiresAt)
    .run();
}

/** Lists tokens, optionally filtered to one owner. Hashes are never returned. */
export async function listTokens(db: D1Database, username?: string): Promise<TokenRow[]> {
  const base = "SELECT id, username, name, role, project, created_at, expires_at, last_used_at FROM tokens";
  const statement = username
    ? db.prepare(`${base} WHERE username = ? ORDER BY created_at`).bind(username)
    : db.prepare(`${base} ORDER BY username, created_at`);
  const result = await statement.all<TokenRow>();
  return result.results;
}

/** Deletes a token; when `username` is given, only if that user owns it. */
export async function deleteToken(db: D1Database, id: string, username?: string): Promise<boolean> {
  const statement = username
    ? db.prepare("DELETE FROM tokens WHERE id = ? AND username = ?").bind(id, username)
    : db.prepare("DELETE FROM tokens WHERE id = ?").bind(id);
  const result = await statement.run();
  return result.meta.changes > 0;
}

export async function touchToken(db: D1Database, id: string): Promise<void> {
  await db
    .prepare("UPDATE tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?")
    .bind(id)
    .run();
}

/** Distinct normalized project names, for the /simple/ root index. */
export async function listProjectNames(db: D1Database): Promise<string[]> {
  const result = await db
    .prepare("SELECT DISTINCT project FROM files ORDER BY project")
    .all<{ project: string }>();
  return result.results.map((row) => row.project);
}

export async function listProjectSummaries(db: D1Database): Promise<ProjectSummary[]> {
  const result = await db
    .prepare(
      `SELECT project, COUNT(*) AS files, COUNT(DISTINCT version) AS versions, MAX(uploaded_at) AS last_upload
       FROM files GROUP BY project ORDER BY project`,
    )
    .all<ProjectSummary>();
  return result.results;
}

export async function filesByProject(db: D1Database, project: string): Promise<FileRow[]> {
  const result = await db
    .prepare("SELECT * FROM files WHERE project = ? ORDER BY filename")
    .bind(project)
    .all<FileRow>();
  return result.results;
}

export async function getFile(db: D1Database, filename: string): Promise<FileRow | null> {
  return db.prepare("SELECT * FROM files WHERE filename = ?").bind(filename).first<FileRow>();
}

/** Inserts a file record; throws Conflict when the filename is already taken. */
export async function insertFile(
  db: D1Database,
  file: {
    filename: string;
    project: string;
    displayName: string;
    version: string;
    filetype: string;
    requiresPython: string | null;
    sha256: string;
    md5: string | null;
    size: number;
    metadataSha256: string | null;
    uploadedBy: string;
  },
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO files
           (filename, project, display_name, version, filetype, requires_python,
            sha256, md5, size, metadata_sha256, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        file.filename,
        file.project,
        file.displayName,
        file.version,
        file.filetype,
        file.requiresPython,
        file.sha256,
        file.md5,
        file.size,
        file.metadataSha256,
        file.uploadedBy,
      )
      .run();
  } catch (err) {
    rethrowUnique(err, `File '${file.filename}' already exists. Delete it first to replace it.`);
  }
}

export async function deleteFileRow(db: D1Database, filename: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM files WHERE filename = ?").bind(filename).run();
  return result.meta.changes > 0;
}

/** Deletes all rows of a project, returning the removed rows for R2 cleanup. */
export async function deleteProjectRows(db: D1Database, project: string): Promise<FileRow[]> {
  const rows = await filesByProject(db, project);
  if (rows.length > 0) {
    await db.prepare("DELETE FROM files WHERE project = ?").bind(project).run();
  }
  return rows;
}

export async function setYanked(
  db: D1Database,
  filename: string,
  yanked: boolean,
  reason: string | null,
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE files SET yanked = ?, yanked_reason = ? WHERE filename = ?")
    .bind(yanked ? 1 : 0, yanked ? reason : null, filename)
    .run();
  return result.meta.changes > 0;
}
