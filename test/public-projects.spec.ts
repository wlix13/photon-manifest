import { describe, expect, it } from "vitest";
import { ADMIN, BASE, api, basicAuth, buildWheel, get, uploadFile } from "./helpers";
import { assertProjectReadable } from "../src/auth";
import { Forbidden, NotFound, Unauthorized } from "../src/errors";
import { deleteFileRow, getProject } from "../src/db";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import app from "../src/index";
import type { IndexScope } from "../src/routes/simple";

const JSON_ACCEPT = "application/vnd.pypi.simple.v1+json";

function writeToken(token: string): string {
  return basicAuth("__token__", token);
}

async function getWithEnv(path: string, overrides: Record<string, unknown>, accept = JSON_ACCEPT): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(`${BASE}${path}`, { headers: { Accept: accept } }), { ...env, ...overrides } as never, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function seedProject(name: string, isPublic: boolean): Promise<void> {
  const wheel = buildWheel(name.replace(/-/g, "_"), "1.0.0");
  const uploaded = await uploadFile(ADMIN, wheel, { name, version: "1.0.0" });
  if (uploaded.status >= 400 && uploaded.status !== 409) throw new Error(`seed ${name}: ${uploaded.status}`);
  const present = await get(`/simple/${name}/`, { auth: ADMIN, accept: JSON_ACCEPT });
  if (present.status !== 200) throw new Error(`seed ${name} missing: ${present.status}`);
  const flip = await api("PUT", `/api/projects/${name}/visibility`, ADMIN, { public: isPublic });
  if (flip.status !== 200) throw new Error(`visibility ${name}: ${flip.status}`);
}

describe("per-project public read", () => {
  it("anonymous root index hides every private project", async () => {
    await seedProject("private-pkg", false);
    await seedProject("public-pkg", false);

    const index = await get("/simple/", { accept: JSON_ACCEPT });
    expect(index.status).toBe(200);
    const listing = (await index.json()) as { meta: object; projects: { name: string }[] };
    expect(listing.projects).not.toContainEqual({ name: "private-pkg" });
    expect(listing.projects).not.toContainEqual({ name: "public-pkg" });
  });

  it("admin can flip a project to public", async () => {
    const wheel = buildWheel("public_pkg", "1.0.0");
    const uploadResp = await uploadFile(ADMIN, wheel, { name: "public-pkg", version: "1.0.0" });
    expect(uploadResp.status).toBeGreaterThanOrEqual(200);
    expect(uploadResp.status).toBeLessThan(300);

    const flip = await api("PUT", "/api/projects/public-pkg/visibility", ADMIN, { public: true });
    expect(flip.status).toBe(200);
    expect(await flip.json()).toEqual({ name: "public-pkg", public: true });

    const anonymous = await get("/simple/public-pkg/", { accept: JSON_ACCEPT });
    expect(anonymous.status).toBe(200);
  });

  it("anonymous root index lists only public projects", async () => {
    await seedProject("private-pkg", false);
    await seedProject("public-pkg", true);
    const index = await get("/simple/", { accept: JSON_ACCEPT });
    expect(index.status).toBe(200);
    const listing = (await index.json()) as { meta: object; projects: { name: string }[] };
    expect(listing.projects).toContainEqual({ name: "public-pkg" });
    expect(listing.projects).not.toContainEqual({ name: "private-pkg" });
  });

  it("anonymous /simple/<public> returns 200", async () => {
    await seedProject("public-pkg", true);
    const project = await get("/simple/public-pkg/", { accept: JSON_ACCEPT });
    expect(project.status).toBe(200);
  });

  it("anonymous file download from public project returns 200", async () => {
    await seedProject("public-pkg", true);
    const wheel = buildWheel("public_pkg", "1.0.0");
    const download = await get(`/files/public-pkg/${wheel.filename}`);
    expect(download.status).toBe(200);
  });

  it("anonymous /simple/<private> returns 401 with WWW-Authenticate", async () => {
    await seedProject("private-pkg", false);

    const project = await get("/simple/private-pkg/", { accept: JSON_ACCEPT });
    expect(project.status).toBe(401);
    expect(project.headers.get("WWW-Authenticate")).toContain('Basic realm="photon-manifest"');
  });

  it("anonymous /files/<private>/<file> returns 401 with WWW-Authenticate", async () => {
    await seedProject("private-pkg", false);

    const wheel = buildWheel("private_pkg", "1.0.0");
    const download = await get(`/files/private-pkg/${wheel.filename}`);
    expect(download.status).toBe(401);
    expect(download.headers.get("WWW-Authenticate")).toContain('Basic realm="photon-manifest"');
  });

  it("anonymous /simple/<unknown> returns 401 with WWW-Authenticate", async () => {
    const project = await get("/simple/unknown-pkg/", { accept: JSON_ACCEPT });
    expect(project.status).toBe(401);
    expect(project.headers.get("WWW-Authenticate")).toContain('Basic realm="photon-manifest"');
  });

  it("anonymous /files/<unknown>/<file> returns 401 with WWW-Authenticate", async () => {
    const download = await get("/files/unknown-pkg/some-file.whl");
    expect(download.status).toBe(401);
    expect(download.headers.get("WWW-Authenticate")).toContain('Basic realm="photon-manifest"');
  });

  it("authenticated fetch of private file still returns 200", async () => {
    await seedProject("private-pkg", false);
    const wheel = buildWheel("private_pkg", "1.0.0");
    const download = await get(`/files/private-pkg/${wheel.filename}`, { auth: ADMIN });
    expect(download.status).toBe(200);
  });

  it("authenticated fetch of unknown project returns 404", async () => {
    const project = await get("/simple/unknown-pkg/", { auth: ADMIN, accept: JSON_ACCEPT });
    expect(project.status).toBe(404);
  });

  it("write token cannot flip visibility and leaves the project untouched", async () => {
    await seedProject("private-pkg", false);
    const created = await api("POST", "/api/users", ADMIN, { username: "flipuser", password: "flip-password-1", role: "write" });
    expect(created.status).toBe(201);

    const tokenResp = await api("POST", "/api/tokens", basicAuth("flipuser", "flip-password-1"), { name: "flip-writer", role: "write" });
    expect(tokenResp.status).toBe(201);
    const { token } = (await tokenResp.json()) as { token: string };

    const flip = await api("PUT", "/api/projects/private-pkg/visibility", writeToken(token), { public: true });
    expect(flip.status).toBe(403);

    const list = await api("GET", "/api/projects", ADMIN);
    const rows = (await list.json()) as Array<{ project: string; public: boolean }>;
    expect(rows.find((row) => row.project === "private-pkg")?.public).toBe(false);
  });

  it("visibility flip on a project with no files is 404", async () => {
    const orphan = buildWheel("empty_pkg", "1.0.0");
    const seeded = await uploadFile(ADMIN, orphan, { name: "empty-pkg", version: "1.0.0" });
    expect([200, 201]).toContain(seeded.status);
    await deleteFileRow(env.DB, orphan.filename);

    const flip = await api("PUT", "/api/projects/empty-pkg/visibility", ADMIN, { public: true });
    expect(flip.status).toBe(404);
  });

  it("anonymous request for a non-normalized private name is 401", async () => {
    await seedProject("private-pkg", false);
    const page = await get("/simple/Private_Pkg/", { accept: JSON_ACCEPT, redirect: "manual" });
    expect(page.status).toBe(401);
  });

  it("malformed body on visibility flip returns 400", async () => {
    const flip = await api("PUT", "/api/projects/public-pkg/visibility", ADMIN, { public: "yes" });
    expect(flip.status).toBe(400);
  });

  it("unknown project on visibility flip returns 404", async () => {
    const flip = await api("PUT", "/api/projects/nonexistent/visibility", ADMIN, { public: true });
    expect(flip.status).toBe(404);
  });

  it("GET /api/projects returns admin view with public flag as boolean and stats", async () => {
    await seedProject("private-pkg", false);
    await seedProject("public-pkg", true);
    const resp = await api("GET", "/api/projects", ADMIN);
    expect(resp.status).toBe(200);
    const projects = (await resp.json()) as { project: string; public: boolean; files: number; versions: number; last_upload: string | null }[];
    const publicPkg = projects.find((p) => p.project === "public-pkg");
    const privatePkg = projects.find((p) => p.project === "private-pkg");
    expect(publicPkg?.public).toBe(true);
    expect(privatePkg?.public).toBe(false);
    expect(publicPkg?.files).toBeGreaterThan(0);
    expect(privatePkg?.files).toBeGreaterThan(0);
  });
});

describe("assertProjectReadable", () => {
  function envWithPublicRead(value: string | undefined) {
    return { PUBLIC_READ: value } as any;
  }

  const publicProject = { name: "pub", public: 1, created_at: "2024-01-01T00:00:00Z" };
  const privateProject = { name: "priv", public: 0, created_at: "2024-01-01T00:00:00Z" };
  const noProject = null;
  const authUser = { username: "user", role: "read" as const, project: null, viaToken: false, anonymous: false };
  const authScoped = { username: "token-user", role: "read" as const, project: "scoped-project", viaToken: true, anonymous: false };

  it("lets an authenticated user read a private project", () => {
    assertProjectReadable(envWithPublicRead(undefined), "priv", privateProject, authUser);
  });

  it("lets anonymous read a public project", () => {
    assertProjectReadable(envWithPublicRead(undefined), "pub", publicProject, null);
  });

  it("401s an auth object flagged anonymous", () => {
    const authAnon = { username: "__anon__", role: "read" as const, viaToken: false, anonymous: true, project: null };
    expect(() => assertProjectReadable(envWithPublicRead(undefined), "priv", privateProject, authAnon)).toThrow(Unauthorized);
  });

  it("401s anonymous on a private project with the Basic challenge", () => {
    let err: unknown;
    try {
      assertProjectReadable(envWithPublicRead(undefined), "priv", privateProject, null);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Unauthorized);
    expect((err as Unauthorized).status).toBe(401);
    expect((err as Unauthorized).headers["WWW-Authenticate"]).toContain('Basic realm="photon-manifest"');
  });

  it("403s a scoped token on another project", () => {
    const otherProject = { name: "other-project", public: 0, created_at: "2024-01-01T00:00:00Z" };
    let err: unknown;
    try {
      assertProjectReadable(envWithPublicRead(undefined), "other-project", otherProject, authScoped);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Forbidden);
    expect((err as Forbidden).status).toBe(403);
  });

  it("404s an authenticated user on a missing project", () => {
    let err: unknown;
    try {
      assertProjectReadable(envWithPublicRead(undefined), "missing", noProject, authUser);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NotFound);
    expect((err as NotFound).status).toBe(404);
  });

  it("lets anonymous read any project when PUBLIC_READ=true", () => {
    assertProjectReadable(envWithPublicRead("true"), "priv", privateProject, null);
    assertProjectReadable(envWithPublicRead("true"), "missing", noProject, null);
  });

  it("scoped token on nonexistent name -> 403 (anti-enumeration)", () => {
    let err: unknown;
    try {
      assertProjectReadable(envWithPublicRead(undefined), "nonexistent", null, authScoped);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Forbidden);
    expect((err as Forbidden).status).toBe(403);
  });

  it("scoped token on its own nonexistent name -> 404", () => {
    let err: unknown;
    try {
      assertProjectReadable(envWithPublicRead(undefined), "scoped-project", null, authScoped);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NotFound);
    expect((err as NotFound).status).toBe(404);
  });
});

describe("PUBLIC_READ at the route level", () => {
  it("serves a private project anonymously and 404s an unknown one", async () => {
    await seedProject("private-pkg", false);

    const priv = await getWithEnv("/simple/private-pkg/", { PUBLIC_READ: "true" });
    expect(priv.status).toBe(200);

    const unknown = await getWithEnv("/simple/never-existed/", { PUBLIC_READ: "true" });
    expect(unknown.status).toBe(404);

    const root = await getWithEnv("/simple/", { PUBLIC_READ: "true" });
    const listing = (await root.json()) as { projects: { name: string }[] };
    expect(listing.projects).toContainEqual({ name: "private-pkg" });
  });
});

describe("indexScope selector", () => {
  type Case = [
    publicRead: boolean,
    anonymous: boolean,
    scopedProject: string | null,
    expected: IndexScope,
  ];

  const cases: Case[] = [
    [true, true, null, "all"],
    [true, true, "proj", "scoped"],
    [true, false, null, "all"],
    [true, false, "proj", "scoped"],
    [false, true, null, "public"],
    [false, true, "proj", "scoped"],
    [false, false, null, "all"],
    [false, false, "proj", "scoped"],
  ];

  for (const [publicRead, anonymous, scopedProject, expected] of cases) {
    it(`publicRead=${publicRead} anonymous=${anonymous} scoped=${scopedProject ?? "null"} -> ${expected}`, async () => {
      const { indexScope } = await import("../src/routes/simple");
      expect(indexScope(publicRead, anonymous, scopedProject)).toBe(expected);
    });
  }
});

describe("per-project public read: additional cases", () => {
  it("anonymous GET of a private project's <file>.metadata returns 401", async () => {
    await seedProject("private-pkg", false);
    const wheel = buildWheel("private_pkg", "1.0.0");
    await uploadFile(ADMIN, wheel, { name: "private-pkg", version: "1.0.0" });

    const download = await get(`/files/private-pkg/${wheel.filename}.metadata`);
    expect(download.status).toBe(401);
    expect(download.headers.get("WWW-Authenticate")).toContain('Basic realm="photon-manifest"');
  });

  it("authenticated root index includes a private project's name", async () => {
    await seedProject("public-pkg", true);
    await seedProject("private-pkg", false);
    const index = await get("/simple/", { auth: ADMIN, accept: JSON_ACCEPT });
    expect(index.status).toBe(200);
    const listing = (await index.json()) as { meta: object; projects: { name: string }[] };
    expect(listing.projects).toContainEqual({ name: "private-pkg" });
    expect(listing.projects).toContainEqual({ name: "public-pkg" });
  });

  it("project-scoped token reading another private project gets 403 while its own project reads 200", async () => {
    await seedProject("private-pkg", false);
    const alice = await api("POST", "/api/users", ADMIN, {
      username: "alice",
      password: "alice-password-1",
      role: "write",
    });
    expect(alice.status).toBe(201);
    const aliceAuth = basicAuth("alice", "alice-password-1");

    const tokenResp = await api("POST", "/api/tokens", aliceAuth, { name: "ci", role: "read", project: "alice-pkg" });
    expect(tokenResp.status).toBe(201);
    const { token } = (await tokenResp.json()) as { token: string };
    const tokenAuth = writeToken(token);

    const wheel = buildWheel("alice_pkg", "1.0.0");
    const uploadResp = await uploadFile(aliceAuth, wheel, { name: "alice-pkg", version: "1.0.0" });
    expect(uploadResp.status).toBeGreaterThanOrEqual(200);
    expect(uploadResp.status).toBeLessThan(300);

    const ownProject = await get("/simple/alice-pkg/", { auth: tokenAuth, accept: JSON_ACCEPT });
    expect(ownProject.status).toBe(200);

    const otherProject = await get("/simple/private-pkg/", { auth: tokenAuth, accept: JSON_ACCEPT });
    expect(otherProject.status).toBe(403);
  });

  it("anonymous request is 401 after authenticated fetch (cache-order proof with cache check)", async () => {
    await seedProject("private-pkg", false);
    const wheel = buildWheel("private_pkg", "1.0.0");
    const fileUrl = `/files/private-pkg/${wheel.filename}`;

    const authDownload = await get(fileUrl, { auth: ADMIN });
    expect(authDownload.status).toBe(200);

    const cached = await caches.default.match(new Request(`https://registry.test${fileUrl}`));
    expect(cached).toBeDefined();

    const anonDownload = await get(fileUrl);
    expect(anonDownload.status).toBe(401);
    expect(anonDownload.headers.get("WWW-Authenticate")).toContain('Basic realm="photon-manifest"');
  });

  it("invalid credentials on a read route return 401 with WWW-Authenticate", async () => {
    await seedProject("public-pkg", true);

    const downgraded = await get("/simple/public-pkg/", { auth: basicAuth("ghost", "nothing"), accept: JSON_ACCEPT });
    expect(downgraded.status).toBe(401);
    expect(downgraded.headers.get("WWW-Authenticate")).toContain("Basic realm=");
    const resp = await get("/simple/public-pkg/", { auth: basicAuth("__token__", "bad-token"), accept: JSON_ACCEPT });
    expect(resp.status).toBe(401);
    expect(resp.headers.get("WWW-Authenticate")).toContain('Basic realm="photon-manifest"');
  });

  it("file response pins Cache-Control: private and Vary: Authorization", async () => {
    await seedProject("public-pkg", true);
    const wheel = buildWheel("public_pkg", "1.0.0");
    await uploadFile(ADMIN, wheel, { name: "public-pkg", version: "1.0.0" });
    const download = await get(`/files/public-pkg/${wheel.filename}`);
    expect(download.status).toBe(200);
    expect(download.headers.get("Cache-Control")).toBe("private");
    expect(download.headers.get("Vary")).toBe("Authorization");
  });

  it("authenticated unknown project on /files returns 404", async () => {
    const download = await get("/files/unknown-pkg/some-file.whl", { auth: ADMIN });
    expect(download.status).toBe(404);
  });

  it("simple index response pins Cache-Control: private and Vary: Accept, Authorization", async () => {
    await seedProject("public-pkg", true);
    const wheel = buildWheel("public_pkg", "1.0.0");
    await uploadFile(ADMIN, wheel, { name: "public-pkg", version: "1.0.0" });
    const project = await get("/simple/public-pkg/", { accept: JSON_ACCEPT });
    expect(project.status).toBe(200);
    expect(project.headers.get("Cache-Control")).toBe("private");
    const vary = project.headers.get("Vary");
    expect(vary).toContain("Accept");
    expect(vary).toContain("Authorization");
  });
});

describe("scoped token root index and file access", () => {
  it("scoped token root index lists only its own project", async () => {
    await seedProject("private-pkg", false);
    await seedProject("public-pkg", true);
    const bob = await api("POST", "/api/users", ADMIN, {
      username: "bob-scoped-index",
      password: "bob-password-1",
      role: "write",
    });
    expect(bob.status).toBe(201);
    const bobAuth = basicAuth("bob-scoped-index", "bob-password-1");

    const tokenResp = await api("POST", "/api/tokens", bobAuth, { name: "ci", role: "read", project: "bob-pkg" });
    expect(tokenResp.status).toBe(201);
    const { token } = (await tokenResp.json()) as { token: string };
    const tokenAuth = writeToken(token);

    const wheel = buildWheel("bob_pkg", "1.0.0");
    const uploadResp = await uploadFile(bobAuth, wheel, { name: "bob-pkg", version: "1.0.0" });
    expect(uploadResp.status).toBeGreaterThanOrEqual(200);
    expect(uploadResp.status).toBeLessThan(300);

    const index = await get("/simple/", { auth: tokenAuth, accept: JSON_ACCEPT });
    expect(index.status).toBe(200);
    const listing = (await index.json()) as { meta: object; projects: { name: string }[] };
    expect(listing.projects).toEqual([{ name: "bob-pkg" }]);
    expect(listing.projects).not.toContainEqual({ name: "private-pkg" });
    expect(listing.projects).not.toContainEqual({ name: "public-pkg" });
  });

  it("scoped token accessing /files/<other-project>/<file> returns 403", async () => {
    await seedProject("private-pkg", false);
    const bob = await api("POST", "/api/users", ADMIN, {
      username: "bob-scoped-files",
      password: "bob-password-2",
      role: "write",
    });
    expect(bob.status).toBe(201);
    const bobAuth = basicAuth("bob-scoped-files", "bob-password-2");

    const tokenResp = await api("POST", "/api/tokens", bobAuth, { name: "ci", role: "read", project: "bob-pkg-2" });
    expect(tokenResp.status).toBe(201);
    const { token } = (await tokenResp.json()) as { token: string };
    const tokenAuth = writeToken(token);

    const wheel = buildWheel("bob_pkg_2", "1.0.0");
    const uploadResp = await uploadFile(bobAuth, wheel, { name: "bob-pkg-2", version: "1.0.0" });
    expect(uploadResp.status).toBeGreaterThanOrEqual(200);
    expect(uploadResp.status).toBeLessThan(300);

    const otherWheel = buildWheel("private_pkg", "1.0.0");
    const download = await get(`/files/private-pkg/${otherWheel.filename}`, { auth: tokenAuth });
    expect(download.status).toBe(403);
  });

  it("scoped token reads only its own admin detail", async () => {
    await seedProject("private-pkg", false);
    await seedProject("public-pkg", true);
    const created = await api("POST", "/api/users", ADMIN, { username: "bob-admin-detail", password: "bob-password-3", role: "write" });
    expect(created.status).toBe(201);
    const bobAuth = basicAuth("bob-admin-detail", "bob-password-3");

    const tokenResp = await api("POST", "/api/tokens", bobAuth, { name: "ci", role: "read", project: "bob-detail-pkg" });
    expect(tokenResp.status).toBe(201);
    const { token } = (await tokenResp.json()) as { token: string };
    const tokenAuth = writeToken(token);

    const uploaded = await uploadFile(bobAuth, buildWheel("bob_detail_pkg", "1.0.0"), { name: "bob-detail-pkg", version: "1.0.0" });
    expect([200, 201]).toContain(uploaded.status);

    const own = await api("GET", "/api/projects/bob-detail-pkg", tokenAuth);
    expect(own.status).toBe(200);

    const other = await api("GET", "/api/projects/private-pkg", tokenAuth);
    expect(other.status).toBe(403);
  });

  it("scoped token stays 403 on another project that is public", async () => {
    await seedProject("public-pkg", true);
    const created = await api("POST", "/api/users", ADMIN, { username: "bob-public-scope", password: "bob-password-4", role: "write" });
    expect(created.status).toBe(201);
    const bobAuth = basicAuth("bob-public-scope", "bob-password-4");

    const tokenResp = await api("POST", "/api/tokens", bobAuth, { name: "ci", role: "read", project: "bob-pkg-4" });
    expect(tokenResp.status).toBe(201);
    const { token } = (await tokenResp.json()) as { token: string };

    const listed = await api("PUT", "/api/projects/public-pkg/visibility", ADMIN, { public: true });
    expect(listed.status).toBe(200);

    const page = await get("/simple/public-pkg/", { auth: writeToken(token), accept: JSON_ACCEPT });
    expect(page.status).toBe(403);
  });

  it("scoped token on another missing name gets 403 at the route", async () => {
    const created = await api("POST", "/api/users", ADMIN, { username: "bob-missing-other", password: "bob-password-6", role: "write" });
    expect(created.status).toBe(201);
    const bobAuth = basicAuth("bob-missing-other", "bob-password-6");

    const tokenResp = await api("POST", "/api/tokens", bobAuth, { name: "ci", role: "read", project: "bob-ghost-2" });
    expect(tokenResp.status).toBe(201);
    const { token } = (await tokenResp.json()) as { token: string };

    const page = await get("/simple/never-existed/", { auth: writeToken(token), accept: JSON_ACCEPT });
    expect(page.status).toBe(403);
  });

  it("root index pins private cache headers", async () => {
    await seedProject("public-pkg", true);
    const index = await get("/simple/", { accept: JSON_ACCEPT });
    expect(index.status).toBe(200);
    expect(index.headers.get("Cache-Control")).toBe("private");
    expect(index.headers.get("Vary")).toContain("Authorization");
  });

  it("scoped token on its own missing project is 404", async () => {
    const created = await api("POST", "/api/users", ADMIN, { username: "bob-ghost", password: "bob-password-5", role: "write" });
    expect(created.status).toBe(201);
    const bobAuth = basicAuth("bob-ghost", "bob-password-5");

    const tokenResp = await api("POST", "/api/tokens", bobAuth, { name: "ci", role: "read", project: "ghost-pkg" });
    expect(tokenResp.status).toBe(201);
    const { token } = (await tokenResp.json()) as { token: string };

    const page = await get("/simple/ghost-pkg/", { auth: writeToken(token), accept: JSON_ACCEPT });
    expect(page.status).toBe(404);
  });
});

describe("public-to-private flip", () => {
  it("anonymous download works when public, then 401 after flip to private; authenticated still works", async () => {
    const wheel = buildWheel("flip_pkg", "1.0.0");
    const uploadResp = await uploadFile(ADMIN, wheel, { name: "flip-pkg", version: "1.0.0" });
    expect(uploadResp.status).toBeGreaterThanOrEqual(200);
    expect(uploadResp.status).toBeLessThan(300);

    const flipPublic = await api("PUT", "/api/projects/flip-pkg/visibility", ADMIN, { public: true });
    expect(flipPublic.status).toBe(200);
    expect(await flipPublic.json()).toEqual({ name: "flip-pkg", public: true });

    const anonDownload1 = await get(`/files/flip-pkg/${wheel.filename}`);
    expect(anonDownload1.status).toBe(200);
    expect(new Uint8Array(await anonDownload1.arrayBuffer())).toEqual(wheel.bytes);

    const anonIndex1 = await get("/simple/flip-pkg/", { accept: JSON_ACCEPT });
    expect(anonIndex1.status).toBe(200);

    const flipPrivate = await api("PUT", "/api/projects/flip-pkg/visibility", ADMIN, { public: false });
    expect(flipPrivate.status).toBe(200);
    expect(await flipPrivate.json()).toEqual({ name: "flip-pkg", public: false });

    const anonDownload2 = await get(`/files/flip-pkg/${wheel.filename}`);
    expect(anonDownload2.status).toBe(401);
    expect(anonDownload2.headers.get("WWW-Authenticate")).toContain('Basic realm="photon-manifest"');

    const anonIndex2 = await get("/simple/flip-pkg/", { accept: JSON_ACCEPT });
    expect(anonIndex2.status).toBe(401);
    expect(anonIndex2.headers.get("WWW-Authenticate")).toContain('Basic realm="photon-manifest"');

    const authDownload = await get(`/files/flip-pkg/${wheel.filename}`, { auth: ADMIN });
    expect(authDownload.status).toBe(200);
    expect(new Uint8Array(await authDownload.arrayBuffer())).toEqual(wheel.bytes);

    const authIndex = await get("/simple/flip-pkg/", { auth: ADMIN, accept: JSON_ACCEPT });
    expect(authIndex.status).toBe(200);
  });
});

describe("last-file delete and scoped GET /api/projects", () => {
  it("deleting the last file removes the project and its visibility", async () => {
    const wheel = buildWheel("reset_pkg", "1.0.0");
    const uploadResp = await uploadFile(ADMIN, wheel, { name: "reset-pkg", version: "1.0.0" });
    expect([200, 201]).toContain(uploadResp.status);

    const flipPublic = await api("PUT", "/api/projects/reset-pkg/visibility", ADMIN, { public: true });
    expect(flipPublic.status).toBe(200);

    const deleteResp = await api("DELETE", "/api/projects/reset-pkg/files/" + wheel.filename, ADMIN);
    expect(deleteResp.status).toBe(200);

    expect(await getProject(env.DB, "reset-pkg")).toBeNull();

    const anonymous = await get("/simple/reset-pkg/", { accept: JSON_ACCEPT });
    expect(anonymous.status).toBe(401);

    const reupload = await uploadFile(ADMIN, wheel, { name: "reset-pkg", version: "1.0.0" });
    expect([200, 201]).toContain(reupload.status);
    const row = await getProject(env.DB, "reset-pkg");
    expect(row?.public).toBe(0);
  });

  it("anonymous 401 after reset-on-empty clears a project's last file", async () => {
    const wheel = buildWheel("reset_pkg2", "1.0.0");
    const uploadResp = await uploadFile(ADMIN, wheel, { name: "reset-pkg2", version: "1.0.0" });
    expect(uploadResp.status).toBeGreaterThanOrEqual(200);
    expect(uploadResp.status).toBeLessThan(300);

    const flipPublic = await api("PUT", "/api/projects/reset-pkg2/visibility", ADMIN, { public: true });
    expect(flipPublic.status).toBe(200);

    const anonBefore = await get(`/files/reset-pkg2/${wheel.filename}`);
    expect(anonBefore.status).toBe(200);

    await api("DELETE", "/api/projects/reset-pkg2/files/" + wheel.filename, ADMIN);

    const anonAfter = await get(`/files/reset-pkg2/${wheel.filename}`);
    expect(anonAfter.status).toBe(401);
    expect(anonAfter.headers.get("WWW-Authenticate")).toContain('Basic realm="photon-manifest"');
  });

  it("scoped GET /api/projects returns only its own project", async () => {
    await seedProject("private-pkg", false);
    await seedProject("public-pkg", true);

    const bob = await api("POST", "/api/users", ADMIN, {
      username: "bob-scoped-projects",
      password: "bob-password-1",
      role: "write",
    });
    expect(bob.status).toBe(201);
    const bobAuth = basicAuth("bob-scoped-projects", "bob-password-1");

    const tokenResp = await api("POST", "/api/tokens", bobAuth, { name: "ci", role: "read", project: "bob-pkg-3" });
    expect(tokenResp.status).toBe(201);
    const { token } = (await tokenResp.json()) as { token: string };
    const tokenAuth = writeToken(token);

    const wheel = buildWheel("bob_pkg_3", "1.0.0");
    const uploadResp = await uploadFile(bobAuth, wheel, { name: "bob-pkg-3", version: "1.0.0" });
    expect(uploadResp.status).toBeGreaterThanOrEqual(200);
    expect(uploadResp.status).toBeLessThan(300);

    const projects = await api("GET", "/api/projects", tokenAuth);
    expect(projects.status).toBe(200);
    const list = (await projects.json()) as { project: string; public: boolean }[];
    expect(list.map((p) => p.project)).toEqual(["bob-pkg-3"]);
  });
});
