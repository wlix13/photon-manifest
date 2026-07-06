import type { Env } from "./env";
import { errorString } from "./utils";

// Header set on cacheable responses indicating whether the body was served from
// the edge cache ("HIT") or freshly from R2 ("MISS").
export const EDGE_CACHE_STATUS_HEADER = "X-Registry-Cache";

// Distribution files are immutable: a filename can never be re-uploaded with new
// bytes. The TTL only bounds how long a deleted-and-replaced filename can still
// be served from a data center that cached it, since cache.delete() only purges
// the data center that ran the Worker.
export const IMMUTABLE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

// The Cache API refuses to store bodies over 512MB.
const MAXIMUM_CACHEABLE_BYTES = 512 * 1024 * 1024;

// We only need waitUntil from the execution context; typing it structurally
// keeps this usable from both the Workers runtime and Hono's context.
type ExecutionContextLike = { waitUntil(promise: Promise<unknown>): void };

export function edgeCacheEnabled(env: Env): boolean {
  return env.EDGE_CACHE !== "off";
}

// The cache key ignores every request header, so the entry is shared across
// clients; authentication has already happened in the route middleware.
function cacheKey(url: string): Request {
  return new Request(url);
}

// A copy is made instead of mutating in place because responses that come out of
// R2 or the Cache API have immutable headers.
function withCacheStatus(response: Response, status: "HIT" | "MISS"): Response {
  const wrapped = new Response(response.body, response);
  wrapped.headers.set(EDGE_CACHE_STATUS_HEADER, status);
  return wrapped;
}

function toClientResponse(cached: Response): Response {
  const response = new Response(cached.body, cached);
  // The stored Cache-Control only exists to set the edge TTL. It must not reach
  // clients: "public" would allow shared HTTP caches between the client and
  // Cloudflare to store responses that required authentication.
  response.headers.delete("Cache-Control");
  return response;
}

function storeInEdgeCache(cache: Cache, url: string, response: Response, context: ExecutionContextLike) {
  // Content-Length is what lets cache.match() serve the stored entry later, so
  // don't store responses without a sane one.
  const contentLength = Number(response.headers.get("Content-Length") ?? NaN);
  if (!Number.isFinite(contentLength) || contentLength > MAXIMUM_CACHEABLE_BYTES) {
    return;
  }

  // Storing is best effort and must never break the response being served.
  try {
    const forCache = withCacheStatus(response.clone(), "HIT");
    forCache.headers.set("Cache-Control", `public, max-age=${IMMUTABLE_MAX_AGE_SECONDS}`);
    context.waitUntil(
      cache.put(cacheKey(url), forCache).catch((err) => {
        console.error("edge cache: error storing response:", errorString(err));
      }),
    );
  } catch (err) {
    console.error("edge cache: error storing response:", errorString(err));
  }
}

// Purges a file's cached download and its ".metadata" companion after the file
// is deleted or replaced. Like all invalidation here, it only purges the data
// center that runs the Worker; other data centers rely on the TTL.
export async function purgeCachedFile(
  env: Env,
  requestUrl: URL,
  project: string,
  filename: string,
): Promise<void> {
  if (!edgeCacheEnabled(env)) {
    return;
  }

  const base = `/files/${project}/${filename}`;
  await Promise.all(
    [base, `${base}.metadata`].map((path) =>
      caches.default.delete(cacheKey(new URL(path, requestUrl).toString())),
    ),
  );
}

// Wraps a download handler with read-through edge caching. Must only run after
// the request has been authenticated.
//
// Note that the Cache API is a no-op on *.workers.dev domains; caching only
// takes effect when the Worker runs on a custom domain or route.
export async function withEdgeCache(
  request: Request,
  env: Env,
  context: ExecutionContextLike,
  next: () => Promise<Response>,
): Promise<Response> {
  if (request.method !== "GET" || !edgeCacheEnabled(env)) {
    return await next();
  }

  const cache = caches.default;
  const url = new URL(request.url).toString();

  const cached = await cache.match(cacheKey(url));
  if (cached !== undefined) {
    return toClientResponse(cached);
  }

  const response = await next();
  if (response.status === 200) {
    storeInEdgeCache(cache, url, response, context);
  }

  return withCacheStatus(response, "MISS");
}
