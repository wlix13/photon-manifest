-- Password-authenticated accounts; role is a strict hierarchy read < write < admin.
CREATE TABLE users (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('read', 'write', 'admin')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- API tokens, presented as the password for user "__token__" (PyPI convention).
-- Only the SHA-256 hex of the token is stored; project restricts write scope.
CREATE TABLE tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL REFERENCES users (username) ON DELETE CASCADE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('read', 'write')),
    project TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    expires_at TEXT,
    last_used_at TEXT
);

CREATE INDEX idx_tokens_username ON tokens (username);

-- One row per uploaded distribution file; project is the PEP 503 normalized name.
CREATE TABLE files (
    filename TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    display_name TEXT NOT NULL,
    version TEXT NOT NULL,
    filetype TEXT NOT NULL,
    requires_python TEXT,
    sha256 TEXT NOT NULL,
    md5 TEXT,
    size INTEGER NOT NULL,
    metadata_sha256 TEXT,
    uploaded_by TEXT NOT NULL,
    uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    yanked INTEGER NOT NULL DEFAULT 0,
    yanked_reason TEXT
);

CREATE INDEX idx_files_project ON files (project);
