// Small async helpers: backoff, retry and a per-key serial queue.

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Exponential backoff with full jitter: a random delay in [0, min(maxMs, baseMs * 2^attempt)]. */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  return Math.floor(Math.random() * Math.min(maxMs, baseMs * 2 ** attempt));
}

export interface RetryOptions {
  attempts: number;
  baseMs: number;
  maxMs: number;
  isRetryable?: (error: unknown) => boolean;
  /** A minimum delay requested by the error itself (for example a rate-limit retry hint). */
  minDelayMs?: (error: unknown) => number | undefined;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  signal?: AbortSignal;
}

/** Run `fn` until it succeeds, a non-retryable error occurs, or `attempts` runs out. */
export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      const retryable = options.isRetryable?.(error) ?? true;
      if (!retryable || attempt + 1 >= options.attempts) throw error;
      const delay = Math.max(backoffDelay(attempt, options.baseMs, options.maxMs), options.minDelayMs?.(error) ?? 0);
      options.onRetry?.(error, attempt + 1, delay);
      await sleep(delay, options.signal);
    }
  }
}

/** Runs tasks one at a time per key, in submission order; different keys run in parallel. */
export class KeyedQueue {
  readonly #tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return result;
  }

  /** Resolves when every queued task has finished. */
  async idle(): Promise<void> {
    while (this.#tails.size > 0) await Promise.all([...this.#tails.values()]);
  }
}
