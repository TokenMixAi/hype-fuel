#!/usr/bin/env node
/**
 * Fails when banned punctuation appears in a tracked file.
 *
 * Em and en dashes are the tell of machine-written prose, and curly quotes break as often as they
 * render, so this project sticks to ASCII punctuation everywhere: code, comments, docs and UI copy
 * alike. Enforcing it here rather than in review is what keeps it true over time.
 *
 * Vendored Foundry dependencies under packages/contracts/lib are somebody else's prose, and the
 * lockfiles are nobody's, so both are skipped.
 *
 * Usage: node scripts/check-prose.mjs
 */
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";

const BANNED = new Map([
  ["\u2014", "em dash"],
  ["\u2013", "en dash"],
  ["\u2018", "curly left single quote"],
  ["\u2019", "curly right single quote"],
  ["\u201c", "curly left double quote"],
  ["\u201d", "curly right double quote"],
]);

const SKIP_PREFIXES = ["packages/contracts/lib/"];
const SKIP_EXACT = new Set(["pnpm-lock.yaml", "foundry.lock"]);
const SKIP_EXTENSIONS = [".png", ".ico", ".jpg", ".jpeg", ".gif", ".woff", ".woff2", ".ttf"];

const repoRoot = new URL("..", import.meta.url).pathname;

// Untracked files count too, so a violation is caught before it is ever committed.
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  {cwd: repoRoot, encoding: "utf8"},
)
  .split("\n")
  .filter(Boolean)
  .filter((file) => !SKIP_PREFIXES.some((prefix) => file.startsWith(prefix)))
  .filter((file) => !SKIP_EXACT.has(file))
  .filter((file) => !SKIP_EXTENSIONS.some((extension) => file.endsWith(extension)));

const pattern = new RegExp(`[${[...BANNED.keys()].join("")}]`, "u");

let failures = 0;

for (const file of files) {
  let contents;
  try {
    contents = readFileSync(new URL(file, new URL("..", import.meta.url)), "utf8");
  } catch {
    // A submodule directory or an unreadable blob is not prose.
    continue;
  }
  if (!pattern.test(contents)) continue;

  contents.split("\n").forEach((line, index) => {
    for (const [character, name] of BANNED) {
      if (!line.includes(character)) continue;
      failures += 1;
      console.log(`${file}:${index + 1}  ${name}`);
      console.log(`  ${line.trim()}`);
    }
  });
}

if (failures > 0) {
  console.log(
    `\n${failures} line(s) with banned punctuation. Use ASCII instead: a comma, colon, semicolon,\n` +
      "parentheses or a full stop in place of a dash, and straight quotes in place of curly ones.",
  );
  process.exit(1);
}

console.log(`No banned punctuation in ${files.length} tracked files.`);
