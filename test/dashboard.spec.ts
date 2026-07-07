import { describe, expect, it } from "vitest";
import { ADMIN, get } from "./helpers";

// The panel is a self-contained SPA shell that loads data client-side from the
// already-tested /api endpoints, so these tests cover the shell and its gate;
// the data it renders is covered by the /api tests in registry.spec.
describe("admin panel", () => {
  it("challenges unauthenticated requests", async () => {
    const response = await get("/admin");
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("Basic");
  });

  it("serves the app shell to an authenticated caller", async () => {
    const response = await get("/admin", { auth: ADMIN });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    const page = await response.text();
    expect(page).toContain("photon-manifest");
    expect(page).toContain('id="projects"');
    expect(page).toContain("/api/projects");
    expect(page).toContain("/api/whoami");
  });
});
