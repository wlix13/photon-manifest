import { applyD1Migrations, env } from "cloudflare:test";

// Runs once per test isolate, before the per-test storage snapshot is taken.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
