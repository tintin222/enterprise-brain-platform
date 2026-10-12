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

/**
 * A task that never runs twice at once: `run()` during a run asks for one more run afterwards, and
 * `schedule()` merges calls within a delay into one run. For catch-ups triggered by many events at once.
 */
export class CoalescedTask {
  readonly #fn: () => Promise<void>;
  readonly #onError: (error: unknown) => void;
  #timer: NodeJS.Timeout | undefined;
  #current: Promise<void> | undefined;
  #again = false;

  constructor(fn: () => Promise<void>, onError: (error: unknown) => void) {
    this.#fn = fn;
    this.#onError = onError;
  }

  schedule(delayMs = 0): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.run();
    }, delayMs);
  }

  /** Resolves once a run that started after this call has finished. */
  run(): Promise<void> {
    if (this.#current) {
      this.#again = true;
      return this.#current;
    }
    this.#current = (async () => {
      try {
        do {
          this.#again = false;
          try {
            await this.#fn();
          } catch (error) {
            this.#onError(error);
          }
        } while (this.#again);
      } finally {
        this.#current = undefined;
      }
    })();
    return this.#current;
  }

  cancel(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** Resolves when no run is in progress (without asking for another run). */
  async idle(): Promise<void> {
    await this.#current;
  }
}

/**
 * A token bucket per key: at most `ratePerSecond` acquisitions per second on average, bursts up to `burst`.
 * Waiters for one key are served in order. Used to stay under the relay's per-key limit (D20) and to pace
 * Mattermost writes.
 */
export class RateLimiter {
  readonly #rate: number;
  readonly #burst: number;
  readonly #buckets = new Map<string, { tokens: number; at: number }>();
  readonly #tails = new Map<string, Promise<void>>();

  constructor(ratePerSecond: number, burst = Math.max(1, Math.ceil(ratePerSecond))) {
    this.#rate = ratePerSecond;
    this.#burst = burst;
  }

  /** Resolves when the caller may proceed; returns how long it waited (ms). */
  acquire(key = ''): Promise<number> {
    const started = Date.now();
    const turn = (this.#tails.get(key) ?? Promise.resolve()).then(() => this.#take(key));
    const tail = turn.catch(() => undefined);
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return turn.then(() => Date.now() - started);
  }

  async #take(key: string): Promise<void> {
    for (;;) {
      const now = Date.now();
      const bucket = this.#buckets.get(key) ?? { tokens: this.#burst, at: now };
      bucket.tokens = Math.min(this.#burst, bucket.tokens + ((now - bucket.at) / 1000) * this.#rate);
      bucket.at = now;
      this.#buckets.set(key, bucket);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return;
      }
      await sleep(Math.ceil(((1 - bucket.tokens) / this.#rate) * 1000));
    }
  }
}
