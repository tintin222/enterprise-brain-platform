import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CoalescedTask, KeyedQueue, retry } from './async.ts';
import { ConfigError, parseConfig } from './config.ts';
import type { Queryable } from './db.ts';
import { KeyStore, KeyStoreError } from './key-store.ts';
import { relayChannelIdFor, replyTarget, threadRoot, uuidv5 } from './nostr.ts';

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
