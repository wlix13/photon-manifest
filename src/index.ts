import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "./auth";
import { HttpError } from "./errors";
import { adminRoutes } from "./routes/admin";
import { dashboardRoutes } from "./routes/dashboard";
import { fileRoutes } from "./routes/files";
import { simpleRoutes } from "./routes/simple";
import { uploadRoutes } from "./routes/upload";

const app = new Hono<AppEnv>({ strict: false });

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ message: err.message }, err.status as ContentfulStatusCode, err.headers);
  }
  console.error("unhandled error:", err);
  return c.json({ message: "Internal server error." }, 500);
});

app.notFound((c) => c.json({ message: "Not found." }, 404));

app.get("/healthz", (c) => c.json({ status: "ok" }));

// API-only service: the bare root has no browsable page and is closed off.
app.all("/", (c) => c.json({ message: "Forbidden." }, 403));

app.route("/simple", simpleRoutes);
app.route("/legacy", uploadRoutes);
app.route("/files", fileRoutes);
app.route("/admin", dashboardRoutes);
app.route("/api", adminRoutes);

export default app;
