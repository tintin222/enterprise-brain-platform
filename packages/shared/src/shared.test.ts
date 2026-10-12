import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CoalescedTask, KeyedQueue, RateLimiter, retry } from './async.ts';
import { ConfigError, parseConfig } from './config.ts';
import type { Queryable } from './db.ts';
import { KeyStore, KeyStoreError } from './key-store.ts';
import { applyEdits, DistinctSigner, generateSecretKeyBytes, relayChannelIdFor, replyTarget, SecretKeySigner, threadRoot, uuidv5 } from './nostr.ts';

const noDb = {} as Queryable;

describe('KeyStore encryption', () => {
  const store = new KeyStore(noDb, randomBytes(32).toString('hex'));

  it('round-trips a secret', () => {
    const sealed = store.encrypt('person:u1', Buffer.from('top secret'));
    expect(store.decrypt({ ref: 'person:u1', nonce: sealed.nonce, ciphertext: sealed.ciphertext, auth_tag: sealed.authTag }).toString()).toBe('top secret');
  });

  it('refuses a ciphertext moved to another ref', () => {
    const sealed = store.encrypt('person:u1', Buffer.from('top secret'));
    expect(() => store.decrypt({ ref: 'person:u2', nonce: sealed.nonce, ciphertext: sealed.ciphertext, auth_tag: sealed.authTag })).toThrow(KeyStoreError);
  });

  it('refuses a different master key', () => {
    const sealed = store.encrypt('r', Buffer.from('x'));
    const other = new KeyStore(noDb, randomBytes(32).toString('hex'));
    expect(() => other.decrypt({ ref: 'r', nonce: sealed.nonce, ciphertext: sealed.ciphertext, auth_tag: sealed.authTag })).toThrow(KeyStoreError);
  });

  it('rejects a master key of the wrong length', () => {
    expect(() => new KeyStore(noDb, 'abcd')).toThrow(KeyStoreError);
  });
});

describe('uuidv5', () => {
  it('matches the RFC 4122 reference vector', () => {
    expect(uuidv5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  it('derives stable relay channel ids', () => {
    expect(relayChannelIdFor('abc')).toBe(relayChannelIdFor('abc'));
    expect(relayChannelIdFor('abc')).not.toBe(relayChannelIdFor('abd'));
  });
});

describe('thread tags', () => {
  it('finds the reply target and the root', () => {
    expect(replyTarget({ tags: [['e', 'p', '', 'reply']] })).toBe('p');
    expect(threadRoot({ tags: [['e', 'r', '', 'root'], ['e', 'p', '', 'reply']] })).toBe('r');
    expect(threadRoot({ tags: [['e', 'p', '', 'reply']] })).toBe('p');
    expect(threadRoot({ tags: [['h', 'x']] })).toBeUndefined();
  });
});

describe('DistinctSigner', () => {
  const recent = new Map<string, number>();
  const signer = new DistinctSigner(new SecretKeySigner(generateSecretKeyBytes()), recent);
  const add = { kind: 9000, tags: [['h', 'ch'], ['p', 'pk']], content: '', created_at: 1_000 };

  it('moves a repeated event one second later so its id differs', () => {
    const first = signer.sign(add);
    signer.sign({ ...add, kind: 9001 });
    const again = signer.sign(add);
    expect(again.created_at).toBe(1_001);
    expect(again.id).not.toBe(first.id);
    expect(signer.sign({ ...add, created_at: 2_000 }).created_at).toBe(2_000);
  });

  it('leaves chat messages deterministic', () => {
    const message = { kind: 9, tags: [['h', 'ch']], content: 'hi', created_at: 1_000 };
    expect(signer.sign(message).id).toBe(signer.sign(message).id);
  });
});

describe('applyEdits', () => {
  const message = { id: 'm1', pubkey: 'alice', content: 'original' };
  const edit = (id: string, pubkey: string, content: string, createdAt: number) => ({ id, pubkey, content, created_at: createdAt, tags: [['e', 'm1']] });

  it('applies the newest edit by the author, by created_at then id', () => {
    const [result] = applyEdits([message], [edit('b', 'alice', 'second', 20), edit('a', 'alice', 'first', 10), edit('c', 'alice', 'tie wins by id', 20)]);
    expect(result?.content).toBe('tie wins by id');
    expect(message.content).toBe('original');
  });

  it('ignores edits by anyone else', () => {
    expect(applyEdits([message], [edit('x', 'mallory', 'forged', 99)])[0]?.content).toBe('original');
  });
});

describe('parseConfig', () => {
  it('names invalid variables without echoing their values', () => {
    const schema = z.object({ SECRET_TOKEN: z.string().regex(/^[0-9a-f]{64}$/) });
    try {
      parseConfig(schema, { SECRET_TOKEN: 'super-secret-value' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toContain('SECRET_TOKEN');
      expect((error as Error).message).not.toContain('super-secret-value');
    }
  });
});

describe('KeyedQueue', () => {
  it('runs tasks for one key in order and keeps going after a failure', async () => {
    const queue = new KeyedQueue();
    const order: number[] = [];
    const slow = (n: number, ms: number) => () => new Promise<void>((resolve) => setTimeout(() => (order.push(n), resolve()), ms));
    const p1 = queue.run('a', slow(1, 30));
    const p2 = queue.run('a', () => Promise.reject(new Error('boom')));
    const p3 = queue.run('a', slow(3, 1));
    await expect(p2).rejects.toThrow('boom');
    await Promise.all([p1, p3]);
    expect(order).toEqual([1, 3]);
    await queue.idle();
  });
});

describe('CoalescedTask', () => {
  it('never overlaps runs and folds calls made during a run into one more run', async () => {
    let running = 0;
    let maxRunning = 0;
    let runs = 0;
    const task = new CoalescedTask(
      async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        runs++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        running--;
      },
      () => undefined,
    );
    const first = task.run();
    void task.run();
    void task.run();
    await first;
    expect(maxRunning).toBe(1);
    expect(runs).toBe(2);
  });

  it('merges scheduled calls within the delay', async () => {
    let runs = 0;
    const task = new CoalescedTask(() => Promise.resolve(void runs++), () => undefined);
    task.schedule(20);
    task.schedule(20);
    task.schedule(20);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(runs).toBe(1);
  });
});

describe('retry', () => {
  it('retries retryable errors and stops at non-retryable ones', async () => {
    let calls = 0;
    await expect(retry(async () => (++calls < 3 ? Promise.reject(new Error('again')) : 'ok'), { attempts: 5, baseMs: 1, maxMs: 2 })).resolves.toBe('ok');
    expect(calls).toBe(3);
    calls = 0;
    await expect(retry(async () => (calls++, Promise.reject(new Error('fatal'))), { attempts: 5, baseMs: 1, maxMs: 2, isRetryable: () => false })).rejects.toThrow('fatal');
    expect(calls).toBe(1);
  });
});

describe('RateLimiter', () => {
  it('lets a burst through, then paces each key on its own', async () => {
    const limiter = new RateLimiter(20, 2);
    const started = Date.now();
    await Promise.all([limiter.acquire('a'), limiter.acquire('a'), limiter.acquire('b')]);
    expect(Date.now() - started).toBeLessThan(30);
    await Promise.all([limiter.acquire('a'), limiter.acquire('a')]);
    // Two more tokens at 20 per second take about 100 ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
  });
});
