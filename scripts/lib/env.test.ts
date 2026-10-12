import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { renderEnv, resolveEnv } from './env.ts';
import { newSecretKeyHex, pubkeyOf } from './nostr.ts';

const template = [
  '# comment kept',
  'MM_URL=http://localhost:8065',
  'BRIDGE_SECRET_KEY=',
  'STATE_DB_PORT=5433',
  'STATE_DB_PASSWORD=',
  'STATE_DATABASE_URL=',
  'RELAY_OWNER_PUBKEY=',
  'MM_BRIDGE_TOKEN=',
  '',
].join('\n');

let counter = 0;
const gens = {
  BRIDGE_SECRET_KEY: newSecretKeyHex,
  STATE_DB_PASSWORD: () => `pw${++counter}`,
};

describe('resolveEnv', () => {
  it('fills defaults, generates missing secrets and derives computed values', () => {
    const { values, generated } = resolveEnv(template, {}, gens);
    expect(values.MM_URL).toBe('http://localhost:8065');
    expect(generated).toEqual(['BRIDGE_SECRET_KEY', 'STATE_DB_PASSWORD']);
    expect(values.RELAY_OWNER_PUBKEY).toBe(pubkeyOf(values.BRIDGE_SECRET_KEY!));
    expect(values.STATE_DATABASE_URL).toBe(`postgres://brain:${values.STATE_DB_PASSWORD}@localhost:5433/brain`);
    expect(values.MM_BRIDGE_TOKEN).toBe('');
  });

  it('never replaces an existing value, so re-running does not rotate keys', () => {
    const first = resolveEnv(template, {}, gens).values;
    const second = resolveEnv(template, first, gens);
    expect(second.generated).toEqual([]);
    expect(second.values).toEqual(first);
  });

  it('re-derives the owner pubkey from the bridge key even if the stored one drifted', () => {
    const first = resolveEnv(template, {}, gens).values;
    const { values } = resolveEnv(template, { ...first, RELAY_OWNER_PUBKEY: 'stale' }, gens);
    expect(values.RELAY_OWNER_PUBKEY).toBe(pubkeyOf(first.BRIDGE_SECRET_KEY!));
  });

  it('keeps keys that are not in the template', () => {
    const { values } = resolveEnv(template, { EXTRA_SETTING: 'x' }, gens);
    expect(values.EXTRA_SETTING).toBe('x');
  });

  it('derives the state database URL from STATE_DB_HOST when one is set (staging)', () => {
    const { values } = resolveEnv(template, { STATE_DB_HOST: 'state-postgres.railway.internal', STATE_DB_PORT: '5432' }, gens);
    expect(values.STATE_DATABASE_URL).toBe(`postgres://brain:${values.STATE_DB_PASSWORD}@state-postgres.railway.internal:5432/brain`);
  });
});

describe('renderEnv', () => {
  it('keeps comments and order, appends unknown keys and round-trips through parseEnv', () => {
    const values = { MM_URL: 'http://localhost:8065', BRIDGE_SECRET_KEY: 'ab', EXTRA: 'has space # and hash' };
    const text = renderEnv(template, values);
    expect(text.startsWith('# comment kept\nMM_URL=http://localhost:8065\nBRIDGE_SECRET_KEY=ab\n')).toBe(true);
    expect(text).toContain('# --- Local additions');
    expect(parseEnv(text)).toMatchObject({ MM_URL: 'http://localhost:8065', BRIDGE_SECRET_KEY: 'ab', EXTRA: 'has space # and hash' });
  });
});
