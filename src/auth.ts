import type { MiddlewareHandler } from "hono";
import type { Env } from "./env";
import type { Role } from "./db";
import { findTokenByHash, getUser, touchToken } from "./db";
import { Forbidden, Unauthorized } from "./errors";

/** Hono environment: bindings plus the per-request auth variable. */
export type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } };

/** Resolved identity of the current request. */
export interface AuthContext {
  username: string;
  role: Role;
  /** Normalized project a token is scoped to, or null for unrestricted. */
  project: string | null;
  /** True when authenticated with an API token rather than a password. */
  viaToken: boolean;
}

/** Structural stand-in for ExecutionContext (Hono and workers-types disagree). */
export type WaitUntilContext = { waitUntil: (promise: Promise<unknown>) => void };

/** Reserved username signalling token authentication (PyPI convention). */
export const TOKEN_USERNAME = "__token__";
export const TOKEN_PREFIX = "spypi-";

const ROLE_ORDER: Record<Role, number> = { read: 0, write: 1, admin: 2 };

/** True when `role` grants at least `required`. */
export function roleAtLeast(role: Role, required: Role): boolean {
  return ROLE_ORDER[role] >= ROLE_ORDER[required];
}

/** The lower of two roles (a token never exceeds its owner's current role). */
export function minRole(a: Role, b: Role): Role {
  return ROLE_ORDER[a] <= ROLE_ORDER[b] ? a : b;
}

/** Extracts the username/password pair from a Basic Authorization header. */
export function parseBasicAuth(request: Request): { username: string; password: string } | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return null;
  let decoded: string;
  try {
    const raw = atob(encoded);
    const bytes = Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  // RFC 7617: reject control characters and pairs without a colon.
  // eslint-disable-next-line no-control-regex
  if (sep === -1 || /[\0-\x1f\x7f]/.test(decoded)) return null;
  return { username: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of a string, hex-encoded. */
export async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** Constant-time string comparison (both sides hashed first so lengths never leak). */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(digestA, digestB);
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));
}

/** Hashes a password as `pbkdf2$<iterations>$<salt-b64>$<hash-b64>`. */
export async function hashPassword(password: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await pbkdf2(password, salt, iterations);
  return `pbkdf2$${iterations}$${toBase64(salt)}$${toBase64(new Uint8Array(derived))}`;
}

/** Verifies a password against a stored `pbkdf2$...` hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, iterationsRaw, saltB64, hashB64] = stored.split("$");
  if (algorithm !== "pbkdf2" || !iterationsRaw || !saltB64 || !hashB64) return false;
  const iterations = Number(iterationsRaw);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;
  let salt: Uint8Array;
  try {
    salt = fromBase64(saltB64);
  } catch {
    return false;
  }
  const derived = await pbkdf2(password, salt, iterations);
  return timingSafeEqual(toBase64(new Uint8Array(derived)), hashB64);
}

function base64url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generates a new API token, returning the plaintext and its stored hash. */
export async function generateToken(): Promise<{ token: string; tokenHash: string }> {
  const token = TOKEN_PREFIX + base64url(crypto.getRandomValues(new Uint8Array(32)));
  return { token, tokenHash: await sha256Hex(token) };
}

async function authenticateToken(
  env: Env,
  token: string,
  ctx?: WaitUntilContext,
): Promise<AuthContext | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const row = await findTokenByHash(env.DB, await sha256Hex(token));
  if (!row) return null;
  if (row.expires_at !== null && Date.parse(row.expires_at) < Date.now()) return null;
  ctx?.waitUntil(touchToken(env.DB, row.id));
  return {
    username: row.username,
    role: minRole(row.token_role, row.user_role),
    project: row.project,
    viaToken: true,
  };
}

/** Resolves Basic credentials to an identity; null when absent or invalid. */
export async function authenticate(
  env: Env,
  request: Request,
  ctx?: WaitUntilContext,
): Promise<AuthContext | null> {
  const credentials = parseBasicAuth(request);
  if (!credentials) return null;

  if (credentials.username === TOKEN_USERNAME) {
    return authenticateToken(env, credentials.password, ctx);
  }

  // The bootstrap admin from Worker secrets shadows any D1 user of the same name.
  if (env.ADMIN_USERNAME && env.ADMIN_PASSWORD) {
    const [userOk, passOk] = await Promise.all([
      timingSafeEqual(credentials.username, env.ADMIN_USERNAME),
      timingSafeEqual(credentials.password, env.ADMIN_PASSWORD),
    ]);
    if (userOk) {
      return passOk
        ? { username: credentials.username, role: "admin", project: null, viaToken: false }
        : null;
    }
  }

  const user = await getUser(env.DB, credentials.username);
  if (!user) return null;
  if (!(await verifyPassword(credentials.password, user.password_hash))) return null;
  return { username: user.username, role: user.role, project: null, viaToken: false };
}

/** Middleware: authenticates the request and enforces a minimum role. */
export function requireAuth(minimum: Role): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    let ctx: WaitUntilContext | undefined;
    try {
      ctx = c.executionCtx;
    } catch {
      ctx = undefined;
    }

    if (c.req.raw.headers.get("Authorization") === null) {
      // Anonymous access is allowed only for reads on a public registry.
      if (minimum === "read" && c.env.PUBLIC_READ === "true") {
        c.set("auth", { username: "anonymous", role: "read", project: null, viaToken: false });
        return next();
      }
      throw new Unauthorized();
    }

    const auth = await authenticate(c.env, c.req.raw, ctx);
    if (!auth) throw new Unauthorized("Invalid credentials.");
    if (!roleAtLeast(auth.role, minimum)) {
      throw new Forbidden(`This operation requires the '${minimum}' role.`);
    }
    c.set("auth", auth);
    return next();
  };
}

/** Throws Forbidden when a project-scoped token targets a different project. */
export function assertProjectAccess(auth: AuthContext, project: string): void {
  if (auth.project !== null && auth.project !== project) {
    throw new Forbidden(`This token is scoped to project '${auth.project}'.`);
  }
}
