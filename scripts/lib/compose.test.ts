// The installation's compose file must pin the same images as the local stack (CLAUDE.md rule 3): one place to
// change a version, and the clean install runs what was tested.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './env.ts';

function imagePins(file: string): Map<string, string> {
  const pins = new Map<string, string>();
  for (const line of readFileSync(path.join(repoRoot, file), 'utf8').split('\n')) {
    const match = /^\s*(?:image:|x-postgres-image: &postgres-image)\s*([^\s#]+)/.exec(line);
    if (!match) continue;
    const reference = match[1]!;
    if (reference.startsWith('*') || reference.startsWith('enterprise-brain/')) continue;
    const name = reference.split('@')[0]!.split(':')[0]!;
    pins.set(name, reference);
  }
  return pins;
}

describe('image pins', () => {
  it('install/compose.yml pins the third-party images exactly as infra/compose.yml does', () => {
    const dev = imagePins('infra/compose.yml');
    const install = imagePins('install/compose.yml');
    // The installation runs our own Mattermost build instead of the Team Edition image the local stack defaults to.
    dev.delete('mattermost/mattermost-team-edition');
    expect([...install.keys()].sort()).toEqual([...dev.keys()].sort());
    for (const [name, reference] of dev) expect(install.get(name), name).toBe(reference);
    for (const reference of install.values()) expect(reference, 'every image is pinned by digest').toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it('the TLS and staging images are pinned by digest too', () => {
    const caddy = readFileSync(path.join(repoRoot, 'install/compose.tls.yml'), 'utf8');
    expect(caddy).toMatch(/image: caddy:[^\s]+@sha256:[0-9a-f]{64}/);
    for (const file of ['infra/state-postgres/Dockerfile', 'infra/services/Dockerfile', 'infra/staging/postgres/Dockerfile']) {
      const text = readFileSync(path.join(repoRoot, file), 'utf8');
      expect(text, file).toMatch(/@sha256:[0-9a-f]{64}/);
    }
  });
});
