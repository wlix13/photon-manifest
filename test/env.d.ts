import type { D1Migration } from "cloudflare:test";
import type { Env as WorkerEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    /** Test bindings: the worker Env plus migrations injected by vitest.config.ts. */
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
