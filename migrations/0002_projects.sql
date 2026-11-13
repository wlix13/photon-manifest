CREATE TABLE projects (
    name TEXT PRIMARY KEY,
    public INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_projects_public ON projects(name) WHERE public = 1;

INSERT OR IGNORE INTO projects (name)
SELECT DISTINCT project FROM files;
