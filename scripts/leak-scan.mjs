#!/usr/bin/env node
/**
 * Leak scanner for a repository about to be published.
 *
 * Run this before every push. It greps the working tree for categories of
 * information that must never reach a public repo.
 *
 *   node scripts/leak-scan.mjs [--dir .] [--terms private-terms.local.json]
 *
 * Exit code 0 = clean, 1 = findings.
 *
 * ---------------------------------------------------------------------------
 * Why there is no list of forbidden words in this file
 *
 * The obvious design — hardcode your company's name, your colleagues' names,
 * your tokens — is self-defeating. The scanner lives in the same repository
 * as the code it polices, so it publishes the very strings it exists to
 * suppress. This file therefore contains only two kinds of rule:
 *
 *   1. Generic shape rules (below), which describe what a secret or a local
 *      path *looks like* and apply to any project.
 *   2. Project-specific literals loaded from --terms, a gitignored file that
 *      stays on your machine.
 *
 * Keep the terms file outside version control. It is loaded at runtime and
 * never written back.
 */

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const DIR = flag('dir', process.cwd());
const TERMS = flag('terms', path.join(DIR, 'private-terms.local.json'));

// ---------------------------------------------------------------------------
// 1. Generic shape rules — safe to publish, no private literals.
const GENERIC_RULES = [
  {
    id: 'credential-shape',
    severity: 'critical',
    patterns: [
      // plaintext assignments to obviously-secret-looking keys
      /\b[a-z_]*(?:secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?token)\b\s*[:=]\s*['"][^'"\n]{8,}['"]/i,
      // token prefixes issued by well-known providers
      /\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{20,}\b/,
      /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/,
      /\bsk-[A-Za-z0-9]{20,}\b/,
      // base64/hex blobs that look like issued keys rather than hashes
      /\b[A-Za-z0-9_-]{40,}\b(?=\s*[,)}\]])/,
    ],
  },
  {
    id: 'local-path',
    severity: 'high',
    patterns: [
      // Windows user profile paths reveal a real machine layout
      /[A-Za-z]:\\Users\\[A-Za-z0-9_.-]+/,
      // POSIX home directories
      /\/(?:home|Users)\/[A-Za-z0-9_.-]+\//,
    ],
  },
  {
    id: 'private-workflow-path',
    severity: 'high',
    // Hardcoded absolute paths to one developer's own project directories
    patterns: [
      /['"][A-Za-z]:\\[^'"\n]*?(?:WorkSpace|Projects|Desktop|Documents)['"]/,
      /['"]\/(?:mnt|home)\/[^'"\n]*?(?:workspace|projects)['"]/,
    ],
  },
  {
    id: 'internal-endpoint',
    severity: 'medium',
    // Internal-only hosts, especially in .env / config files
    patterns: [
      /\bhttps?:\/\/(?:[\w.-]+\.)?(?:internal|intranet|corp|local)(?::\d+)?\b/i,
    ],
  },
];

// ---------------------------------------------------------------------------
// 2. Project-specific literals — loaded, never stored here.
function loadTerms(file) {
  if (!fs.existsSync(file)) return { rules: [], missing: true };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[error] could not parse ${file}: ${err.message}`);
    process.exit(2);
  }
  const rules = [];
  for (const group of data.categories || []) {
    if (!Array.isArray(group.patterns) || !group.patterns.length) continue;
    let compiled;
    try {
      compiled = group.patterns.map((p) => new RegExp(p, 'i'));
    } catch (err) {
      console.error(`[error] bad regex in category "${group.id}": ${err.message}`);
      process.exit(2);
    }
    rules.push({
      id: group.id,
      severity: group.severity || 'critical',
      patterns: compiled,
    });
  }
  return { rules, missing: false };
}

const { rules: termRules, missing } = loadTerms(TERMS);
const RULES = [...GENERIC_RULES, ...termRules];

// ---------------------------------------------------------------------------

const SCAN_EXT = new Set(['.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.txt', '.yml', '.yaml', '.toml', '.sh', '.env']);
const SKIP_DIR = new Set(['node_modules', '.git', '.tmp', 'dist', 'build', 'coverage']);

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (SCAN_EXT.has(path.extname(entry.name)) || entry.name.startsWith('.env')) acc.push(full);
  }
  return acc;
}

const files = walk(DIR);
const findings = [];
const allowlist = new Set(['leak-scan.mjs', 'private-terms.local.json']);

for (const file of files) {
  const rel = path.relative(DIR, file);
  if (allowlist.has(rel)) continue; // the policer is not policed
  const text = fs.readFileSync(file, 'utf8');
  text.split(/\r?\n/).forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.patterns.some((re) => re.test(line))) {
        findings.push({ rel, line: i + 1, rule: rule.id, severity: rule.severity, text: line.trim() });
        break;
      }
    }
  });
}

console.log(`scanned ${files.length} files under ${DIR}`);
console.log(`rules: ${GENERIC_RULES.length} generic + ${termRules.length} from ${missing ? '(terms file not found)' : path.basename(TERMS)}\n`);

if (missing) {
  console.warn('note: no terms file found, so project-specific literals were NOT checked.');
  console.warn('      create private-terms.local.json (gitignored) to enable those rules.\n');
}

if (!findings.length) {
  console.log('CLEAN — no credentials, local paths, or private literals found.');
  process.exit(0);
}

const counts = { critical: 0, high: 0, medium: 0, low: 0 };
for (const f of findings) counts[f.severity]++;

const byRule = {};
for (const f of findings) (byRule[f.rule] ||= []).push(f);

for (const [rule, list] of Object.entries(byRule)) {
  console.log(`[${list[0].severity.toUpperCase()}] ${rule} — ${list.length} hit(s)`);
  for (const f of list.slice(0, 12)) {
    const preview = f.text.length > 110 ? f.text.slice(0, 110) + '…' : f.text;
    console.log(`   ${f.rel}:${f.line}  ${preview}`);
  }
  if (list.length > 12) console.log(`   … and ${list.length - 12} more`);
  console.log('');
}

console.log(`summary: ${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low`);
process.exit(1);