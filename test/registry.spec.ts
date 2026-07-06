import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { fileKey } from "../src/storage";
import { ADMIN, api, basicAuth, buildWheel, get, sha256Hex, uploadFile } from "./helpers";

const JSON_ACCEPT = "application/vnd.pypi.simple.v1+json";
const WHEEL = buildWheel("test_package", "1.0.0");

describe("authentication", () => {
  it("serves /healthz without credentials", async () => {
    expect((await get("/healthz")).status).toBe(200);
  });

  it("forbids the bare root (no landing page)", async () => {
    expect((await get("/")).status).toBe(403);
  });

  it("challenges unauthenticated requests", async () => {
    const response = await get("/simple/");
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("Basic");
  });

  it("rejects invalid credentials", async () => {
    expect((await get("/simple/", { auth: basicAuth("admin", "wrong") })).status).toBe(401);
    expect((await get("/simple/", { auth: basicAuth("ghost", "nothing") })).status).toBe(401);
  });
});

describe("upload and simple API", () => {
  it("uploads a wheel and serves both index flavors", async () => {
    expect((await uploadFile(ADMIN, WHEEL, { name: "test-package", version: "1.0.0" })).status).toBe(200);

    const index = await get("/simple/", { auth: ADMIN, accept: JSON_ACCEPT });
    expect(index.headers.get("Content-Type")).toBe(JSON_ACCEPT);
    const listing = (await index.json()) as { meta: object; projects: { name: string }[] };
    expect(listing.meta).toEqual({ "api-version": "1.1" });
    expect(listing.projects).toContainEqual({ name: "test-package" });

    const project = await get("/simple/test-package/", { auth: ADMIN, accept: JSON_ACCEPT });
    const body = (await project.json()) as {
      versions: string[];
      files: { filename: string; url: string; hashes: { sha256: string }; size: number }[];
    };
    expect(body.versions).toEqual(["1.0.0"]);
    expect(body.files).toHaveLength(1);
    expect(body.files[0]?.filename).toBe(WHEEL.filename);
    expect(body.files[0]?.hashes.sha256).toBe(await sha256Hex(WHEEL.bytes));
    expect(body.files[0]?.size).toBe(WHEEL.bytes.length);

    const html = await get("/simple/test-package/", { auth: ADMIN });
    expect(html.headers.get("Content-Type")).toContain("text/html");
    const page = await html.text();
    expect(page).toContain(`#sha256=${await sha256Hex(WHEEL.bytes)}`);
    expect(page).toContain("data-core-metadata");
  });

  it("redirects non-normalized project names", async () => {
    await uploadFile(ADMIN, WHEEL, { name: "test-package", version: "1.0.0" });
    const response = await get("/simple/Test_Package/", { auth: ADMIN, redirect: "manual" });
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toContain("/simple/test-package/");
  });

  it("serves file bytes and PEP 658 metadata", async () => {
    await uploadFile(ADMIN, WHEEL, { name: "test-package", version: "1.0.0" });

    const download = await get(`/files/test-package/${WHEEL.filename}`, { auth: ADMIN });
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(WHEEL.bytes);

    const metadata = await get(`/files/test-package/${WHEEL.filename}.metadata`, { auth: ADMIN });
    expect(metadata.status).toBe(200);
    expect(await metadata.text()).toContain("Name: test_package");
  });

  it("rejects duplicate filenames with 409", async () => {
    await uploadFile(ADMIN, WHEEL, { name: "test-package", version: "1.0.0" });
    const again = await uploadFile(ADMIN, WHEEL, { name: "test-package", version: "1.0.0" });
    expect(again.status).toBe(409);
  });

  it("rejects digest mismatches", async () => {
    const response = await uploadFile(
      ADMIN,
      WHEEL,
      { name: "test-package", version: "1.0.0" },
      { sha256_digest: "0".repeat(64) },
    );
    expect(response.status).toBe(400);
  });

  it("rejects name/version mismatches with the filename", async () => {
    expect((await uploadFile(ADMIN, WHEEL, { name: "other-package", version: "1.0.0" })).status).toBe(400);
    expect((await uploadFile(ADMIN, WHEEL, { name: "test-package", version: "2.0.0" })).status).toBe(400);
  });
});

describe("users and tokens", () => {
  // Storage is shared across tests in a run, so each test gets its own user.
  async function createUser(username: string, role = "write"): Promise<string> {
    const response = await api("POST", "/api/users", ADMIN, {
      username,
      password: `${username}-password-1`,
      role,
    });
    expect(response.status).toBe(201);
    return basicAuth(username, `${username}-password-1`);
  }

  it("lets users authenticate with passwords and manage their tokens", async () => {
    const bob = await createUser("bob1");

    const whoami = await api("GET", "/api/whoami", bob);
    expect(await whoami.json()).toMatchObject({ username: "bob1", role: "write", viaToken: false });

    const created = await api("POST", "/api/tokens", bob, { name: "ci" });
    expect(created.status).toBe(201);
    const { token } = (await created.json()) as { token: string };
    expect(token).toMatch(/^spypi-/);

    const tokenAuth = basicAuth("__token__", token);
    const ownWheel = buildWheel("token_pkg", "1.0.0");
    expect((await uploadFile(tokenAuth, ownWheel, { name: "token-pkg", version: "1.0.0" })).status).toBe(200);
    expect(
      (await api("GET", "/api/whoami", tokenAuth).then((r) => r.json())) as object,
    ).toMatchObject({ username: "bob1", viaToken: true });

    // Tokens must not mint further tokens.
    expect((await api("POST", "/api/tokens", tokenAuth, { name: "nested" })).status).toBe(403);
  });

  it("enforces token role and project scope", async () => {
    const bob = await createUser("bob2");

    const readToken = (await (
      await api("POST", "/api/tokens", bob, { name: "ro", role: "read" })
    ).json()) as { token: string };
    expect(
      (await uploadFile(basicAuth("__token__", readToken.token), WHEEL, {
        name: "test-package",
        version: "1.0.0",
      })).status,
    ).toBe(403);

    const scoped = (await (
      await api("POST", "/api/tokens", bob, { name: "scoped", project: "other-project" })
    ).json()) as { token: string };
    expect(
      (await uploadFile(basicAuth("__token__", scoped.token), WHEEL, {
        name: "test-package",
        version: "1.0.0",
      })).status,
    ).toBe(403);
  });

  it("keeps admin endpoints away from non-admins", async () => {
    const bob = await createUser("bob3");
    expect((await api("GET", "/api/users", bob)).status).toBe(403);
    expect((await api("DELETE", "/api/projects/test-package", bob)).status).toBe(403);
  });

  it("rejects expired tokens", async () => {
    const bob = await createUser("bob4");
    const created = (await (
      await api("POST", "/api/tokens", bob, { name: "old", expires_in_days: 0.00000001 })
    ).json()) as { token: string };
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await get("/simple/", { auth: basicAuth("__token__", created.token) })).status).toBe(401);
  });
});

describe("yank and delete", () => {
  it("yanks and unyanks files", async () => {
    await uploadFile(ADMIN, WHEEL, { name: "test-package", version: "1.0.0" });

    const yank = await api(
      "POST",
      `/api/projects/test-package/files/${WHEEL.filename}/yank`,
      ADMIN,
      { reason: "broken" },
    );
    expect(yank.status).toBe(200);

    const page = await get("/simple/test-package/", { auth: ADMIN });
    expect(await page.text()).toContain('data-yanked="broken"');

    const json = await get("/simple/test-package/", { auth: ADMIN, accept: JSON_ACCEPT });
    const body = (await json.json()) as { files: { yanked: unknown }[] };
    expect(body.files[0]?.yanked).toBe("broken");

    await api("POST", `/api/projects/test-package/files/${WHEEL.filename}/unyank`, ADMIN);
    const after = (await (
      await get("/simple/test-package/", { auth: ADMIN, accept: JSON_ACCEPT })
    ).json()) as { files: { yanked: unknown }[] };
    expect(after.files[0]?.yanked).toBe(false);
  });

  it("deletes files and projects", async () => {
    await uploadFile(ADMIN, WHEEL, { name: "test-package", version: "1.0.0" });

    const del = await api("DELETE", `/api/projects/test-package/files/${WHEEL.filename}`, ADMIN);
    expect(del.status).toBe(200);
    expect((await get("/simple/test-package/", { auth: ADMIN })).status).toBe(404);
    expect((await get(`/files/test-package/${WHEEL.filename}`, { auth: ADMIN })).status).toBe(404);

    // Re-upload works after deletion, then project-level delete cleans up.
    expect((await uploadFile(ADMIN, WHEEL, { name: "test-package", version: "1.0.0" })).status).toBe(200);
    expect((await api("DELETE", "/api/projects/test-package", ADMIN)).status).toBe(200);
    expect((await get("/simple/test-package/", { auth: ADMIN })).status).toBe(404);
  });
});

describe("download caching", () => {
  it("serves immutable files from cache and evicts them on delete", async () => {
    const wheel = buildWheel("cached_pkg", "1.0.0");
    await uploadFile(ADMIN, wheel, { name: "cached-pkg", version: "1.0.0" });
    const url = `/files/cached-pkg/${wheel.filename}`;

    const miss = await get(url, { auth: ADMIN });
    expect(miss.status).toBe(200);
    expect(miss.headers.get("X-Registry-Cache")).toBe("MISS");
    // The edge TTL Cache-Control must not leak to clients.
    expect(miss.headers.get("Cache-Control")).toBeNull();
    expect(new Uint8Array(await miss.arrayBuffer())).toEqual(wheel.bytes);

    // Delete the object straight from R2 so a subsequent 200 can only be a cache hit.
    await env.PACKAGES.delete(fileKey("cached-pkg", wheel.filename));
    const hit = await get(url, { auth: ADMIN });
    expect(hit.status).toBe(200);
    expect(hit.headers.get("X-Registry-Cache")).toBe("HIT");
    expect(new Uint8Array(await hit.arrayBuffer())).toEqual(wheel.bytes);

    // Deleting through the API purges the cache, so the next read misses.
    await api("DELETE", `/api/projects/cached-pkg/files/${wheel.filename}`, ADMIN);
    expect((await get(url, { auth: ADMIN })).status).toBe(404);
  });
});
