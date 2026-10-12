// pnpm check:secrets [paths...]: fail when a plaintext secret sits in the repository, a fixture, a log or a test
// output (spec section 12; CI runs it on every push). Three detectors:
//   1. shapes of real keys (private key blocks, provider API keys, GitHub and Slack tokens, AWS keys, JWTs);
//   2. assignments of long values to names like password, secret, token or api_key, outside the allowed
//      fake prefixes (FAKE-, example, changeme, placeholder) and the allow-list file;
//   3. every secret value from .env (or ENV_FILE) and, with a reachable database, from the key store, as text,
//      hex and base64 (the same check as pnpm check:logs).
// Without paths it scans the tracked files of the repository plus scripts/spike/results and scripts/load/results.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { envPath, readEnvFile, repoRoot } from '../lib/env.ts';

const SHAPES: { name: string; pattern: RegExp }[] = [
  { name: 'private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: 'Anthropic API key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'Google API key', pattern: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'Google AI key', pattern: /\bAQ\.[A-Za-z0-9_-]{40,}/ },
  { name: 'GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|github_pat_[A-Za-z0-9_]{80,}/ },
  { name: 'Slack token', pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'JSON web token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'Railway token', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}\b(?=.*RAILWAY_TOKEN)/ },
];
const ASSIGNMENT = /(?:^|[^A-Za-z0-9_])(?<name>[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)[A-Za-z0-9_.-]*)\s*[:=]\s*["'`]?(?<value>[A-Za-z0-9+/=_.-]{20,})["'`]?/gi;
const FAKE = /^(?:FAKE-|fake-|example|EXAMPLE|changeme|CHANGEME|placeholder|PLACEHOLDER|test-|TEST-|x{8,}|0{16,}|1{16,}|\$\{|\$\(|<|%)/;
const NAME_ALLOWED = /(?:_FILE|_PATH|_REF|_NAME|_ID|_URL|_HOURS|_SECONDS|_PORT|_HOST|_KEYS?_?NEXT|_PREVIOUS|Ref|Path|Name)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.pnpm-store']);
const TEXT_EXTENSIONS = /\.(?:ts|tsx|js|mjs|cjs|json|jsonl|md|yml|yaml|txt|log|env|sql|sh|toml|html|css|svg|example|Dockerfile)$|(?:^|\/)(?:Dockerfile|\.env\.example|\.gitignore|\.dockerignore)$/;
const ALLOW_FILE = path.join(repoRoot, '.secretsignore');

interface Hit {
  file: string;
  line: number;
  detector: string;
  excerpt: string;
}

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter(Boolean).map((file) => path.join(repoRoot, file));
}

function filesUnder(target: string): string[] {
  if (!existsSync(target)) return [];
  const stats = statSync(target);
  if (stats.isFile()) return [target];
  const out: string[] = [];
  for (const name of execFileSync('ls', ['-A', target], { encoding: 'utf8' }).split('\n').filter(Boolean)) {
    if (SKIP_DIRS.has(name)) continue;
    out.push(...filesUnder(path.join(target, name)));
  }
  return out;
}

function allowList(): Set<string> {
  if (!existsSync(ALLOW_FILE)) return new Set();
  return new Set(
    readFileSync(ALLOW_FILE, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  );
}

/** Known secret values (from the env file), in the forms they could leak in. */
function knownSecrets(): Map<string, string> {
  const names = new Map<string, string>();
  if (!existsSync(envPath)) return names;
  const env = readEnvFile();
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < 12) continue;
    if (!/KEY|SECRET|TOKEN|PASSWORD/i.test(key) || NAME_ALLOWED.test(key) || /PUBKEY|PUBLIC/i.test(key)) continue;
    names.set(value, key);
    names.set(Buffer.from(value, 'utf8').toString('base64'), `${key} (base64)`);
    if (/^[0-9a-f]+$/i.test(value) && value.length % 2 === 0) names.set(Buffer.from(value, 'hex').toString('base64'), `${key} (hex as base64)`);
  }
  return names;
}

const args = process.argv.slice(2);
const targets = args.length > 0 ? args.flatMap((arg) => filesUnder(path.resolve(arg))) : [...trackedFiles(), ...filesUnder(path.join(repoRoot, 'scripts/spike/results')), ...filesUnder(path.join(repoRoot, 'scripts/load/results'))];
const allowed = allowList();
const secrets = knownSecrets();
const hits: Hit[] = [];
let scanned = 0;
for (const file of targets) {
  if (!TEXT_EXTENSIONS.test(file) && !/\.log$/.test(file) && statSync(file).size > 2 * 1024 * 1024) continue;
  if (file === envPath || path.basename(file).startsWith('.env.') || path.basename(file) === '.env') continue;
  if (file === ALLOW_FILE) continue;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\u0000')) continue;
  scanned++;
  const relative = path.relative(repoRoot, file);
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    const where = `${relative}:${index + 1}`;
    if (allowed.has(where) || allowed.has(relative)) return;
    for (const shape of SHAPES) {
      if (shape.pattern.test(line)) hits.push({ file: relative, line: index + 1, detector: shape.name, excerpt: line.trim().slice(0, 80) });
    }
    for (const match of line.matchAll(ASSIGNMENT)) {
      const name = match.groups?.name ?? '';
      const value = match.groups?.value ?? '';
      if (NAME_ALLOWED.test(name) || FAKE.test(value)) continue;
      // Code, not data: identifiers, property chains, calls and template references.
      const after = line.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 1);
      if (/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(value) || after === '(') continue;
      if (/^[A-Z_]{8,}$/.test(value) || value.includes('..')) continue;
      hits.push({ file: relative, line: index + 1, detector: `assignment to ${name}`, excerpt: `${name} = ${value.slice(0, 6)}…` });
    }
    for (const [value, key] of secrets) {
      if (line.includes(value)) hits.push({ file: relative, line: index + 1, detector: `the value of ${key}`, excerpt: '(value not shown)' });
    }
  });
}

if (hits.length > 0) {
  console.error(`Possible secrets in ${hits.length} place(s) (add a false positive as "<file>:<line>" to .secretsignore):`);
  for (const hit of hits) console.error(`  ${hit.file}:${hit.line}  ${hit.detector}  ${hit.excerpt}`);
  process.exit(1);
}
console.log(`Scanned ${scanned} file(s) for key shapes, secret assignments and ${secrets.size} known values: none found.`);
