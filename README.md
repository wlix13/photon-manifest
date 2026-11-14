# photon-manifest

A private, PyPI-compatible Python package index that runs entirely on Cloudflare Workers: **R2** stores the package files, **D1** stores users, API tokens and file metadata. No servers, no containers.

Works with `pip`, `uv`, `twine` and `poetry`. It implements the modern simple-index protocol end to end: PEP 503 HTML and PEP 691 JSON (chosen by `Accept` content negotiation), PEP 700 `versions` / `size` / `upload-time` fields, and PEP 658/714 core metadata - the wheel's `METADATA` is extracted at upload and served at `<file-url>.metadata`. Files can be yanked (PEP 592), and publishing goes through the legacy twine/uv/poetry upload API (`POST /legacy/`).

## Setup

Requirements: Node 20+, pnpm, a Cloudflare account.

```bash
pnpm install
cp wrangler.example.jsonc wrangler.jsonc

# Create the production resources and fill their ids into the env.production
# block of wrangler.jsonc
npx wrangler d1 create photon-manifest
npx wrangler r2 bucket create photon-manifest-packages

# Apply the schema
pnpm run db:migrate

# Bootstrap admin (lives in Worker secrets, not in D1)
npx wrangler secret put ADMIN_USERNAME --env production
npx wrangler secret put ADMIN_PASSWORD --env production

pnpm run deploy
```

For local development: `cp .dev.vars.example .dev.vars`, then
`pnpm run db:migrate:local && pnpm dev`. The `dev` environment in
`wrangler.jsonc` points at its own D1/R2 ids (Miniflare simulates them
locally), so it never touches production data.

## Custom domain & caching

Out of the box the Worker answers at
`https://photon-manifest.<subdomain>.workers.dev`. For production, put it on your own hostname - add a route to the `env.production` block of `wrangler.jsonc` and redeploy:

```jsonc
"routes": [{ "pattern": "pypi.example.com", "custom_domain": true }]
```

A custom domain also turns on edge caching of downloads (Cloudflare's Cache API), which is on by default and controlled by the `EDGE_CACHE` var (`"off"`
disables it). It is a no-op on `*.workers.dev` - hits only happen behind a custom domain, where repeated installs skip D1 and R2 entirely. Responses carry
an `X-Registry-Cache: HIT`/`MISS` header; the edge TTL's `Cache-Control` is kept server-side and never sent to clients, so an authenticated download is never
stored by a shared cache between the client and Cloudflare.

Authentication still runs on every request, so a cache hit never serves bytes to an unauthorized client. Files are immutable, but the cache TTL is only a week and deleting a file evicts its cached copy in the data center that handled the delete - other regions fall back to that TTL, so replace a bad release by publishing a new version rather than reusing a filename.

## Authentication

Everything uses HTTP Basic auth, in two forms:

- **Username / password** - the bootstrap admin from secrets, plus database users managed through the API.
- **API tokens** - username `__token__`, password `spypi-...`
  (the PyPI convention). Tokens are hashed (SHA-256) before storage,
  can expire, and can be scoped to a single project.

Roles: `read` (install packages) < `write` (upload, yank, delete own files)
< `admin` (manage users and projects). Set `PUBLIC_READ = "true"` to allow
anonymous installs while keeping uploads authenticated.

### Per-project public access

Projects can be marked `public`, which makes them installable without credentials while the rest of the registry stays private.
`PUBLIC_READ=true` still makes everything anonymous-readable and takes precedence over the per-project flag.
Listing projects is open to any `read` role; changing visibility requires `admin`.

```bash
BASE=https://pypi.example.com

# List projects with visibility and stats
curl -u admin $BASE/api/projects
# => [{"project":"my-pkg","files":3,"versions":2,"last_upload":"...","public":true},...]

# Make project public
curl -u admin -X PUT $BASE/api/projects/my-pkg/visibility \
  -H 'Content-Type: application/json' \
  -d '{"public":true}'
# => {"name":"my-pkg","public":true}

# Make project private again
curl -u admin -X PUT $BASE/api/projects/my-pkg/visibility \
  -H 'Content-Type: application/json' \
  -d '{"public":false}'
```

A project has no visibility row until its first upload, and deleting a project's last file removes the project, so a re-upload starts private.
Anonymous clients see only public projects on the root index (`/simple/`) unless `PUBLIC_READ=true`, and a project-scoped token's root index lists only its own project.
Anonymous requests get **401** with a Basic challenge (so pip and keyring prompt) unless the project is public or `PUBLIC_READ=true`, whether or not the name exists.
After credentials, an unknown project is 404.
A project-scoped token reading any other project is 403, even when the name does not exist - that avoids enumeration; on its own missing name it is 404.
The `public` field in JSON responses is a boolean.

### Manage users and tokens

```bash
BASE=https://pypi.example.com

# Create a user (admin only)
curl -u admin -X POST $BASE/api/users \
  -H 'Content-Type: application/json' \
  -d '{"username": "bob", "password": "s3cret-pass", "role": "write"}'

# Bob creates a CI token, scoped to one project, valid 90 days
curl -u bob -X POST $BASE/api/tokens \
  -H 'Content-Type: application/json' \
  -d '{"name": "ci", "project": "my-package", "expires_in_days": 90}'
# => {"token": "spypi-...", ...}   the plaintext is returned exactly once
```

Notes: token creation requires password auth (a token cannot mint tokens), and tokens belong to database users - the bootstrap admin should create a real user for itself first.

## Client configuration

Install:

```bash
pip install --index-url https://bob:s3cret-pass@pypi.example.com/simple/ my-package
uv add --index https://pypi.example.com/simple/ my-package   # credentials via UV_INDEX_* or keyring
```

Publish:

```bash
twine upload --repository-url https://pypi.example.com/legacy/ dist/*
# username: __token__     password: spypi-...

uv publish --publish-url https://pypi.example.com/legacy/ \
  --username __token__ --password spypi-... dist/*
```

`~/.pypirc` for twine:

```ini
[distutils]
index-servers = private

[private]
repository = https://pypi.example.com/legacy/
username = __token__
password = spypi-...
```

## Behavior worth knowing

- **Filenames are immutable** - re-uploading the identical file is no-op 200, so retried publishes are safe; different bytes under existing filename return 409, delete file first if you really need to replace it.
- Uploads verify the client-provided `sha256_digest` against the received bytes before anything is stored, and R2 re-verifies the digest on write.
- Project-scoped tokens are restricted to their own project for reads, uploads, deletes and yanks.
- User, token and project management lives under `/api/*` - see `whoami`, `users`, `tokens` and `projects`. `GET /api/whoami` is the quickest way to confirm which identity and role your credentials resolve to.

## Limits

- Workers caps request bodies at **100 MB** (free plan) - larger wheels cannot be uploaded. `MAX_UPLOAD_MB` can set a stricter cap.
- The **free plan's 10 ms CPU limit** is tight for PBKDF2: lower `PBKDF2_ITERATIONS` (e.g. 10000) or prefer API tokens, which only cost a single SHA-256. On the paid plan keep 100000+.
- D1 free tier holds 500 MB of metadata - effectively unlimited for file records; the packages themselves live in R2.

## Development

```bash
pnpm run typecheck   # tsc over src/ and test/
pnpm test            # vitest, runs inside workerd with real D1/R2 bindings
```

Layout: `src/routes/` (HTTP surface: simple, upload, files, admin) over
`src/` core modules (`auth`, `db`, `names`, `simple`, `metadata`,
`storage`), with the D1 schema in `migrations/`.
