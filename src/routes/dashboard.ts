import { Hono } from "hono";
import type { AppEnv } from "../auth";
import { requireAuth } from "../auth";

// A browser-facing admin panel served at /admin.
//
// It is a self-contained HTML page (inline CSS + JS, no external dependencies)
// that drives the existing /api/ JSON endpoints from the browser:
//   - GET    /api/whoami                              -> identity + role
//   - GET    /api/projects                            -> project summaries
//   - GET    /api/projects/<name>                     -> the project's files
//   - DELETE /api/projects/<name>                     -> delete a whole project
//   - DELETE /api/projects/<name>/files/<filename>    -> delete one file
//   - POST   /api/projects/<name>/files/<file>/yank   -> yank / unyank a file
//
// The page shell is served behind requireAuth("read"), so the browser prompts
// for Basic credentials on navigation and then replays them on the same-origin
// fetches above. Viewing needs "read"; yank/delete need "write" and deleting a
// project needs "admin" - the UI only shows those buttons when the caller's role
// allows it, and any leftover 403 is surfaced as a toast.

const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Python Artifactory admin</title>
<style>
  :root {
    --bg: #f6f7f9;
    --panel: #ffffff;
    --panel-2: #fafbfc;
    --border: #e4e7eb;
    --text: #1f2328;
    --muted: #656d76;
    --accent: #2563eb;
    --accent-fg: #ffffff;
    --danger: #cf222e;
    --danger-bg: #ffebe9;
    --ok: #2da44e;
    --badge-bg: #eef1f4;
    --shadow: 0 1px 2px rgba(0,0,0,.06), 0 1px 3px rgba(0,0,0,.05);
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117;
      --panel: #161b22;
      --panel-2: #12161c;
      --border: #30363d;
      --text: #e6edf3;
      --muted: #8b949e;
      --accent: #388bfd;
      --accent-fg: #ffffff;
      --danger: #f85149;
      --danger-bg: #3a0f11;
      --ok: #3fb950;
      --badge-bg: #21262d;
      --shadow: 0 1px 2px rgba(0,0,0,.4);
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  header {
    position: sticky; top: 0; z-index: 20;
    display: flex; align-items: center; gap: 14px;
    padding: 12px 20px;
    background: color-mix(in srgb, var(--panel) 88%, transparent);
    backdrop-filter: saturate(1.4) blur(8px);
    border-bottom: 1px solid var(--border);
  }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 650; }
  .brand svg { color: var(--accent); }
  .brand small { color: var(--muted); font-weight: 500; font-size: 12px; }
  .grow { flex: 1; }
  .search {
    display: flex; align-items: center; gap: 8px;
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 8px; padding: 6px 10px; min-width: 200px;
  }
  .search input { border: 0; outline: 0; background: transparent; color: var(--text); width: 100%; font-size: 13px; }
  .search svg { color: var(--muted); flex: none; }
  main { max-width: 1000px; margin: 0 auto; padding: 20px; }
  .statusbar { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 13px; margin-bottom: 14px; flex-wrap: wrap; }
  .statusbar .dot { width: 4px; height: 4px; border-radius: 50%; background: var(--muted); opacity: .5; }

  button {
    font: inherit; cursor: pointer; border-radius: 8px;
    border: 1px solid var(--border); background: var(--panel); color: var(--text);
    padding: 6px 12px; transition: background .12s, border-color .12s, opacity .12s;
  }
  button:hover { background: var(--panel-2); }
  button:active { transform: translateY(0.5px); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
  button.primary:hover { filter: brightness(1.06); background: var(--accent); }
  button.danger { color: var(--danger); }
  button.danger:hover { background: var(--danger-bg); border-color: var(--danger); }
  button.sm { padding: 3px 9px; font-size: 12px; }

  .project {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 10px; margin-bottom: 10px; box-shadow: var(--shadow); overflow: hidden;
  }
  .project-head, .file-head {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 14px; cursor: pointer; user-select: none;
  }
  .project-head:hover, .file-head:hover { background: var(--panel-2); }
  .project-name { font-weight: 600; }
  .caret { display: inline-flex; color: var(--muted); transition: transform .15s ease; flex: none; }
  .project.open > .project-head .caret, .file.open > .file-head .caret { transform: rotate(90deg); }
  .badge {
    font-size: 12px; color: var(--muted); background: var(--badge-bg);
    border-radius: 999px; padding: 1px 9px; white-space: nowrap;
  }
  .badge.mono { font-family: var(--mono); }
  .badge.warn { color: var(--danger); background: var(--danger-bg); }
  .project-body, .file-body { display: none; }
  .project.open > .project-body, .file.open > .file-body { display: block; }
  .project-body { border-top: 1px solid var(--border); background: var(--panel-2); }

  .file { border-bottom: 1px solid var(--border); }
  .file:last-child { border-bottom: 0; }
  .file-head { padding: 10px 14px 10px 30px; }
  .file-name { font-family: var(--mono); font-size: 13px; word-break: break-all; }
  .file.yanked .file-name { text-decoration: line-through; text-decoration-color: var(--danger); }
  .file-body { padding: 4px 14px 16px 30px; }

  .kv { display: grid; grid-template-columns: 130px 1fr; gap: 6px 14px; align-items: start; }
  .kv dt { color: var(--muted); font-size: 12px; padding-top: 2px; }
  .kv dd { margin: 0; }
  .mono { font-family: var(--mono); font-size: 12.5px; word-break: break-all; }
  .copy { cursor: pointer; border: 0; background: transparent; color: inherit; padding: 0; font: inherit; text-align: left; }
  .copy:hover { color: var(--accent); background: transparent; }
  .row-actions { margin-top: 14px; display: flex; gap: 8px; flex-wrap: wrap; }
  .muted { color: var(--muted); }
  .spin { display: inline-block; width: 13px; height: 13px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: sp .7s linear infinite; vertical-align: -2px; }
  @keyframes sp { to { transform: rotate(360deg); } }

  .empty { text-align: center; color: var(--muted); padding: 60px 20px; }
  .empty svg { color: var(--border); }

  .overlay {
    position: fixed; inset: 0; z-index: 40; display: none;
    align-items: center; justify-content: center;
    background: rgba(0,0,0,.4); padding: 20px;
  }
  .overlay.show { display: flex; }
  .dialog {
    background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
    box-shadow: 0 12px 40px rgba(0,0,0,.35); width: 100%; max-width: 440px; padding: 20px;
  }
  .dialog h3 { margin: 0 0 8px; font-size: 16px; }
  .dialog p { margin: 0 0 16px; color: var(--muted); }
  .dialog .mono { color: var(--text); }
  .dialog input[type=text] { width: 100%; font: inherit; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--panel-2); color: var(--text); margin: 0 0 16px; }
  .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }

  #toasts { position: fixed; right: 16px; bottom: 16px; z-index: 60; display: flex; flex-direction: column; gap: 8px; }
  .toast {
    background: var(--panel); border: 1px solid var(--border); border-left: 3px solid var(--accent);
    border-radius: 8px; box-shadow: var(--shadow); padding: 10px 14px; max-width: 360px; font-size: 13px;
    animation: slidein .18s ease;
  }
  .toast.error { border-left-color: var(--danger); }
  .toast.success { border-left-color: var(--ok); }
  @keyframes slidein { from { opacity: 0; transform: translateY(6px); } }
</style>
</head>
<body>
<header>
  <div class="brand">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/></svg>
    <span>photon-manifest <small>/ admin</small></span>
  </div>
  <div class="grow"></div>
  <label class="search">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
    <input id="filter" type="search" placeholder="Filter projects" autocomplete="off" />
  </label>
  <button id="refresh">Refresh</button>
</header>
<main>
  <div class="statusbar"><span id="status">Loading…</span><span class="dot"></span><span id="whoami" class="muted"></span></div>
  <div id="projects"></div>
</main>

<div class="overlay" id="overlay"><div class="dialog" id="dialog"></div></div>
<div id="toasts"></div>

<script>
"use strict";
(function () {
  var els = {
    projects: document.getElementById("projects"),
    status: document.getElementById("status"),
    whoami: document.getElementById("whoami"),
    filter: document.getElementById("filter"),
    refresh: document.getElementById("refresh"),
    overlay: document.getElementById("overlay"),
    dialog: document.getElementById("dialog"),
    toasts: document.getElementById("toasts")
  };

  var role = "read";
  var projectEls = []; // { name, el }

  function canWrite() { return role === "write" || role === "admin"; }
  function canAdmin() { return role === "admin"; }

  // --- tiny hyperscript helper (avoids innerHTML, so text is always escaped) ---
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      for (var k in props) {
        var v = props[k];
        if (v == null) continue;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k === "html") el.innerHTML = v; // only used with static strings
        else if (k.indexOf("on") === 0 && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
        else el.setAttribute(k, v);
      }
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      if (Array.isArray(c)) {
        for (var j = 0; j < c.length; j++) { if (c[j] != null) el.appendChild(typeof c[j] === "string" ? document.createTextNode(c[j]) : c[j]); }
      } else {
        el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      }
    }
    return el;
  }

  function caret() {
    return h("span", { class: "caret", html: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 4l4 4-4 4"/></svg>' });
  }

  function fmtBytes(n) {
    if (n == null || isNaN(n)) return "—";
    if (n === 0) return "0 B";
    var u = ["B", "KB", "MB", "GB", "TB"];
    var i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
    return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + " " + u[i];
  }
  function fmtDate(s) {
    if (!s) return "—";
    var d = new Date(s);
    return isNaN(d.getTime()) ? s : d.toLocaleString();
  }
  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }
  function shortHash(x) { return x && x.length > 20 ? x.slice(0, 16) + "…" : (x || "—"); }

  function toast(msg, kind) {
    var t = h("div", { class: "toast" + (kind ? " " + kind : ""), text: msg });
    els.toasts.appendChild(t);
    setTimeout(function () {
      t.style.transition = "opacity .3s";
      t.style.opacity = "0";
      setTimeout(function () { t.remove(); }, 300);
    }, kind === "error" ? 6000 : 3500);
  }

  function enc(s) { return encodeURIComponent(s); }

  async function api(path, opts) {
    opts = opts || {};
    opts.credentials = "same-origin";
    opts.headers = Object.assign({ Accept: "application/json" }, opts.headers || {});
    var res = await fetch(path, opts);
    if (res.status === 401 || res.status === 403) {
      var e = new Error(res.status === 403 ? "forbidden" : "unauthorized");
      e.denied = true;
      throw e;
    }
    return res;
  }

  function handleError(err, action) {
    if (err && err.denied) {
      toast("Not authorized to " + action + ". Your role may be insufficient or your session expired.", "error");
    } else {
      toast("Failed to " + action + ": " + (err && err.message ? err.message : "unknown error"), "error");
    }
  }

  // ---------------- Identity ----------------
  async function loadWhoami() {
    try {
      var res = await api("/api/whoami");
      if (!res.ok) return;
      var me = await res.json();
      role = me.role || "read";
      var scope = me.project ? " · scoped to " + me.project : "";
      els.whoami.textContent = "signed in as " + (me.username || "?") + " (" + role + ")" + scope;
    } catch (e) { /* non-fatal; panel still lists in read-only mode */ }
  }

  // ---------------- Projects ----------------
  async function loadProjects() {
    els.projects.innerHTML = "";
    projectEls = [];
    els.status.textContent = "Loading projects…";
    try {
      var res = await api("/api/projects");
      if (!res.ok) throw new Error("HTTP " + res.status);
      var list = await res.json();
      list.sort(function (a, b) { return a.project < b.project ? -1 : a.project > b.project ? 1 : 0; });
      for (var i = 0; i < list.length; i++) addProject(list[i]);
      updateStatus();
      if (list.length === 0) showEmpty();
      applyFilter();
    } catch (err) {
      handleError(err, "load projects");
      els.status.textContent = "Error loading projects.";
    }
  }

  function showEmpty() {
    els.projects.appendChild(
      h("div", { class: "empty" },
        h("div", { html: '<svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/></svg>' }),
        h("p", null, "Nothing published yet. Upload a package with twine or uv to get started.")
      )
    );
  }

  function updateStatus() {
    var shown = projectEls.filter(function (r) { return r.el.style.display !== "none"; }).length;
    var total = projectEls.length;
    els.status.textContent = total === 0 ? "No projects"
      : (shown === total ? plural(total, "project") : shown + " of " + plural(total, "project"));
  }

  function addProject(summary) {
    var name = summary.project;
    var head = h("div", { class: "project-head" },
      caret(),
      h("span", { class: "project-name", text: name }),
      h("a", { class: "badge", href: "/simple/" + enc(name) + "/", title: "Open the simple index", onclick: function (e) { e.stopPropagation(); } }, "index"),
      h("span", { class: "badge", text: plural(summary.files, "file") }),
      h("span", { class: "badge", text: plural(summary.versions, "version") }),
      h("span", { class: "grow" }),
      h("span", { class: "muted", style: "font-size:12px", text: "updated " + fmtDate(summary.last_upload) }),
      canAdmin() ? h("button", { class: "sm danger", title: "Delete this project and all its files", onclick: function (e) { e.stopPropagation(); confirmDeleteProject(name, project); } }, "Delete") : null
    );
    var body = h("div", { class: "project-body" });
    var project = h("div", { class: "project" }, head, body);
    project._loaded = false;
    head.addEventListener("click", function () {
      var open = project.classList.toggle("open");
      if (open && !project._loaded) loadFiles(name, body, head);
    });
    els.projects.appendChild(project);
    projectEls.push({ name: name, el: project });
    return project;
  }

  async function loadFiles(name, body, head) {
    body.innerHTML = "";
    body.appendChild(h("div", { class: "muted", style: "padding:12px 14px 12px 30px" }, h("span", { class: "spin" }), " Loading files…"));
    try {
      var res = await api("/api/projects/" + enc(name));
      if (!res.ok) throw new Error("HTTP " + res.status);
      var data = await res.json();
      var files = (data.files || []).slice().sort(function (a, b) {
        return a.uploaded_at < b.uploaded_at ? 1 : a.uploaded_at > b.uploaded_at ? -1 : 0;
      });
      body.innerHTML = "";
      body.parentNode._loaded = true;
      if (files.length === 0) {
        body.appendChild(h("div", { class: "muted", style: "padding:12px 14px 12px 30px" }, "No files."));
        return;
      }
      for (var i = 0; i < files.length; i++) body.appendChild(makeFile(name, files[i]));
    } catch (err) {
      body.innerHTML = "";
      body.appendChild(h("div", { class: "muted", style: "padding:12px 14px 12px 30px" }, "Failed to load files."));
      handleError(err, "load files for " + name);
    }
  }

  // ---------------- File ----------------
  function makeFile(name, file) {
    var actions = [];
    if (canWrite()) {
      actions.push(file.yanked
        ? h("button", { class: "sm", title: "Unyank this file", onclick: function (e) { e.stopPropagation(); doUnyank(name, file, fileEl); } }, "Unyank")
        : h("button", { class: "sm", title: "Yank this file", onclick: function (e) { e.stopPropagation(); confirmYank(name, file, fileEl); } }, "Yank"));
      actions.push(h("button", { class: "sm danger", title: "Delete this file", onclick: function (e) { e.stopPropagation(); confirmDeleteFile(name, file, fileEl); } }, "Delete"));
    }
    var head = h("div", { class: "file-head" },
      caret(),
      h("span", { class: "file-name", text: file.filename }),
      file.yanked ? h("span", { class: "badge warn", text: "yanked" }) : null,
      h("span", { class: "grow" }),
      h("span", { class: "badge mono", text: fmtBytes(file.size) }),
      actions.length ? h("span", { style: "display:flex;gap:6px" }, actions) : null
    );
    var fileEl = h("div", { class: "file" + (file.yanked ? " yanked" : "") }, head, buildFileBody(name, file));
    head.addEventListener("click", function () { fileEl.classList.toggle("open"); });
    return fileEl;
  }

  // The /api/projects/<name> endpoint returns raw file rows (snake_case columns).
  function buildFileBody(name, file) {
    var kv = h("dl", { class: "kv" });
    function row(k, valNode) { kv.appendChild(h("dt", { text: k })); kv.appendChild(h("dd", null, valNode)); }

    row("Version", h("span", { class: "mono", text: file.version }));
    row("Type", h("span", { class: "mono", text: file.filetype }));
    row("Size", document.createTextNode(fmtBytes(file.size)));
    if (file.requires_python) row("Requires-Python", h("span", { class: "mono", text: file.requires_python }));
    row("SHA-256", hashField(file.sha256));
    row("Core metadata", document.createTextNode(file.metadata_sha256 ? "available" : "none"));
    row("Uploaded by", document.createTextNode(file.uploaded_by || "—"));
    row("Uploaded", document.createTextNode(fmtDate(file.uploaded_at)));
    if (file.yanked) row("Yank reason", h("span", { class: "muted", text: file.yanked_reason || "no reason given" }));

    var body = h("div", { class: "file-body" });
    body.appendChild(kv);
    body.appendChild(
      h("div", { class: "row-actions" },
        h("button", { class: "sm", onclick: function () { downloadFile(name, file.filename); } }, "Download")
      )
    );
    return body;
  }

  function downloadFile(name, filename) {
    var a = h("a", { href: "/files/" + enc(name) + "/" + enc(filename), download: filename });
    document.body.appendChild(a); a.click(); a.remove();
  }

  function hashField(digest) {
    if (!digest) return h("span", { class: "muted" }, "—");
    return h("button", {
      class: "copy mono", title: "Click to copy sha256:" + digest,
      onclick: function () {
        if (navigator.clipboard) navigator.clipboard.writeText(digest).then(function () { toast("Digest copied", "success"); });
      }
    }, shortHash(digest));
  }

  // ---------------- Destructive actions ----------------
  function confirmYank(name, file, fileEl) {
    var input = h("input", { type: "text", placeholder: "Reason (optional)", maxlength: "200" });
    openDialog({
      title: "Yank file",
      body: [
        h("p", null, "Yank ", h("span", { class: "mono", text: file.filename }), "? Installers keep resolving it only when explicitly pinned."),
        input
      ],
      confirmLabel: "Yank",
      danger: true,
      onConfirm: async function () {
        var res = await api("/api/projects/" + enc(name) + "/files/" + enc(file.filename) + "/yank", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: input.value || undefined })
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        file.yanked = 1; file.yanked_reason = input.value || null;
        swapFile(name, fileEl, file);
        toast(file.filename + " yanked", "success");
      }
    });
  }

  async function doUnyank(name, file, fileEl) {
    try {
      var res = await api("/api/projects/" + enc(name) + "/files/" + enc(file.filename) + "/unyank", { method: "POST" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      file.yanked = 0; file.yanked_reason = null;
      swapFile(name, fileEl, file);
      toast(file.filename + " unyanked", "success");
    } catch (err) { handleError(err, "unyank " + file.filename); }
  }

  // Rebuild a file row after its state changed, preserving whether it was expanded.
  function swapFile(name, oldEl, file) {
    var fresh = makeFile(name, file);
    if (oldEl.classList.contains("open")) fresh.classList.add("open");
    oldEl.replaceWith(fresh);
  }

  function confirmDeleteFile(name, file, fileEl) {
    openDialog({
      title: "Delete file",
      body: [h("p", null, "Permanently delete ", h("span", { class: "mono", text: file.filename }), "? Filenames are immutable and cannot be reused. This cannot be undone.")],
      confirmLabel: "Delete file",
      danger: true,
      onConfirm: async function () {
        var res = await api("/api/projects/" + enc(name) + "/files/" + enc(file.filename), { method: "DELETE" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        if (fileEl && fileEl.parentNode) fileEl.remove();
        toast(file.filename + " deleted", "success");
      }
    });
  }

  function confirmDeleteProject(name, projectEl) {
    openDialog({
      title: "Delete project",
      body: [h("p", null, "Delete ", h("span", { class: "mono", text: name }), " and every file it contains? This cannot be undone.")],
      confirmLabel: "Delete project",
      danger: true,
      onConfirm: async function () {
        var res = await api("/api/projects/" + enc(name), { method: "DELETE" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        if (projectEl && projectEl.parentNode) projectEl.remove();
        projectEls = projectEls.filter(function (r) { return r.name !== name; });
        updateStatus();
        toast("Project " + name + " deleted", "success");
      }
    });
  }

  // ---------------- Dialog ----------------
  function openDialog(opts) {
    els.dialog.innerHTML = "";
    var confirmBtn = h("button", { class: opts.danger ? "danger" : "primary" }, opts.confirmLabel || "Confirm");
    var cancelBtn = h("button", null, "Cancel");
    cancelBtn.addEventListener("click", closeDialog);
    confirmBtn.addEventListener("click", async function () {
      confirmBtn.disabled = true; cancelBtn.disabled = true;
      var prev = confirmBtn.textContent;
      confirmBtn.innerHTML = '<span class="spin"></span> Working…';
      try {
        await opts.onConfirm();
        closeDialog();
      } catch (err) {
        handleError(err, (opts.confirmLabel || "confirm").toLowerCase());
        confirmBtn.disabled = false; cancelBtn.disabled = false;
        confirmBtn.textContent = prev;
      }
    });
    var content = [h("h3", { text: opts.title })];
    (opts.body || []).forEach(function (b) { content.push(b); });
    content.push(h("div", { class: "dialog-actions" }, cancelBtn, confirmBtn));
    content.forEach(function (c) { els.dialog.appendChild(c); });
    els.overlay.classList.add("show");
  }
  function closeDialog() { els.overlay.classList.remove("show"); els.dialog.innerHTML = ""; }
  els.overlay.addEventListener("click", function (e) { if (e.target === els.overlay) closeDialog(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDialog(); });

  // ---------------- Filter ----------------
  function applyFilter() {
    var q = els.filter.value.trim().toLowerCase();
    projectEls.forEach(function (r) { r.el.style.display = (!q || r.name.toLowerCase().indexOf(q) >= 0) ? "" : "none"; });
    updateStatus();
  }
  els.filter.addEventListener("input", applyFilter);
  els.refresh.addEventListener("click", loadProjects);

  (async function init() {
    await loadWhoami();
    await loadProjects();
  })();
})();
</script>
</body>
</html>`;

export const dashboardRoutes = new Hono<AppEnv>({ strict: false });

dashboardRoutes.get("/", requireAuth("read"), () => {
  return new Response(ADMIN_HTML, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
});
