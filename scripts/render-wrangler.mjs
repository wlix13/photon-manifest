#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]*)(?::-([^}]*))?\}/g;
const COMMENT = /^(\s*)\/\/\s?(.*)$/;

function usage() {
  return `Usage: render-wrangler.mjs [options]

Options:
  --template <path>   Template file (default: wrangler.example.jsonc)
  --out <path>        Output file (default: wrangler.jsonc)
  --check             Render and report, write nothing
  --help              Show this help and exit

\${VAR} needs a value and fails the render without one. \${VAR:-fallback} uses the
fallback. A commented line whose placeholders all resolve is activated; a comment
that cannot resolve stays a comment.
`;
}

const args = process.argv.slice(2);
let templatePath = join(ROOT, 'wrangler.example.jsonc');
let outputPath = join(ROOT, 'wrangler.jsonc');
let check = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--help') {
    process.stdout.write(usage());
    process.exit(0);
  }
  if (arg === '--check') {
    check = true;
    continue;
  }
  if (arg === '--template' || arg === '--out') {
    if (i + 1 >= args.length) {
      process.stderr.write(`ERROR: ${arg} requires a path\n${usage()}`);
      process.exit(2);
    }
    if (arg === '--template') templatePath = resolve(args[++i]);
    else outputPath = resolve(args[++i]);
    continue;
  }
  process.stderr.write(`ERROR: unknown argument: ${arg}\n${usage()}`);
  process.exit(2);
}

let template;
try {
  template = readFileSync(templatePath, 'utf8');
} catch (error) {
  process.stderr.write(`ERROR: cannot read ${templatePath}: ${error.message}\n`);
  process.exit(1);
}

function lookup(name, fallback) {
  const value = process.env[name];
  if (value !== undefined && value !== '') return value;
  if (fallback !== undefined) return fallback;
  return null;
}

function render(text, missing) {
  return text.replace(PLACEHOLDER, (whole, name, fallback) => {
    const value = lookup(name, fallback);
    if (value === null) {
      if (!missing.includes(name)) missing.push(name);
      return whole;
    }
    return value;
  });
}

const substituted = new Set();
const missing = [];
const lines = [];

for (const line of template.split('\n')) {
  const commented = line.match(COMMENT);
  if (commented !== null) {
    const inner = commented[2];
    const names = [...inner.matchAll(PLACEHOLDER)];
    const resolvable = names.length > 0 && names.every(([, name, fallback]) => lookup(name, fallback) !== null);
    if (!resolvable) {
      lines.push(line);
      continue;
    }
    lines.push(commented[1] + render(inner, missing));
    for (const [, name] of names) substituted.add(name);
    continue;
  }
  const names = [...line.matchAll(PLACEHOLDER)];
  lines.push(render(line, missing));
  for (const [, name] of names) substituted.add(name);
}

const text = lines.join('\n');
const unresolved = [
  ...new Set(
    text
      .split('\n')
      .filter((line) => !COMMENT.test(line))
      .flatMap((line) => [...line.matchAll(PLACEHOLDER)].map((match) => match[1])),
  ),
].filter((name) => !missing.includes(name));
const leftoverToken = text.includes('REPLACE_WITH');
const failed = missing.length > 0 || unresolved.length > 0 || leftoverToken;

if (missing.length > 0) process.stderr.write(`ERROR: missing or empty: ${missing.join(', ')}\n`);
if (unresolved.length > 0) process.stderr.write(`ERROR: unresolved: ${unresolved.join(', ')}\n`);
if (leftoverToken) process.stderr.write('ERROR: REPLACE_WITH remains\n');

process.stdout.write(`Substituted: ${substituted.size === 0 ? '(none)' : [...substituted].join(', ')}\n`);
process.stdout.write(`Missing: ${missing.length === 0 ? '(none)' : missing.join(', ')}\n`);

const bytes = Buffer.byteLength(text, 'utf8');

if (check) {
  process.stdout.write(`check: would write ${outputPath} (${bytes} bytes)\n`);
  process.exit(failed ? 1 : 0);
}
if (failed) process.exit(1);

writeFileSync(outputPath, text);
process.stdout.write(`wrote ${outputPath} (${bytes} bytes)\n`);
