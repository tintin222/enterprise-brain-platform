// NFR-10: every string the pages show comes from the catalog. Ids used in the sources must exist in en.json;
// ids built from a prefix and a value (`type.${…}`) must have an entry for every value of that enumeration.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import en from './i18n/en.json';

const ENTITY_TYPES = ['person', 'system', 'requirement', 'document', 'credential_ref', 'task', 'decision', 'conversation', 'meeting', 'package', 'agent', 'agent_note'];
const CONTAINER_KINDS = ['project', 'topic', 'general'];
const CONTAINER_STATUSES = ['active', 'archived'];
const MATCHES = ['keyword', 'semantic'];
const PERSON_FIELDS = ['role', 'organisation', 'workingHours', 'preferredChannel', 'expertise', 'responsibilities'];
const CONTAINER_ROLES = ['sponsor', 'product_owner', 'end_user', 'developer', 'fde', 'reviewer', 'member'];
const WHY = ['profile', 'evidence'];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) return sources(file);
    return /\.tsx?$/.test(name) && !name.endsWith('.test.ts') ? [file] : [];
  });
}

describe('string catalog', () => {
  const catalog = en as Record<string, string>;
  const text = sources(path.resolve(import.meta.dirname)).map((file) => readFileSync(file, 'utf8')).join('\n');

  it('has every literal id the pages use', () => {
    const used = new Set<string>();
    for (const match of text.matchAll(/id(?::|=)\s*['"]([a-zA-Z0-9_.]+)['"]/g)) used.add(match[1]!);
    for (const match of text.matchAll(/\{ id: '([a-zA-Z0-9_.]+)' \}/g)) used.add(match[1]!);
    const missing = [...used].filter((id) => !(id in catalog));
    expect(missing).toEqual([]);
  });

  it('has every id built from a prefix and an enumeration value', () => {
    const prefixes = new Set<string>();
    for (const match of text.matchAll(/id(?:=\{|: )`([a-zA-Z0-9_.]+)\.\$\{/g)) prefixes.add(match[1]!);
    const values: Record<string, string[]> = { type: ENTITY_TYPES, 'containers.kind': CONTAINER_KINDS, 'containers.status': CONTAINER_STATUSES, 'search.matched': MATCHES, person: PERSON_FIELDS, role: CONTAINER_ROLES, 'search.why': WHY };
    for (const prefix of prefixes) {
      expect(values, `no enumeration known for the prefix "${prefix}"`).toHaveProperty(prefix);
      for (const value of values[prefix] ?? []) expect(catalog, `${prefix}.${value}`).toHaveProperty(`${prefix}.${value}`);
    }
  });

  it('has no empty messages', () => {
    expect(Object.entries(catalog).filter(([, value]) => value.trim() === '')).toEqual([]);
  });
});
