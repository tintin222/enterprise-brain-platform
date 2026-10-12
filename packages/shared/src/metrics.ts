// Prometheus metrics and the operations endpoint every service exposes (Phase 6): GET /healthz (the process
// is up), GET /readyz (its dependencies answer) and GET /metrics. Metrics live in one registry per process;
// when several services run in one process (the e2e tests) they share it.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import { errorFields, type Logger } from './logger.ts';

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry, prefix: 'brain_' });

/** A counter in the shared registry (created once per process). */
export function counter<L extends string>(name: string, help: string, labelNames: readonly L[] = []): Counter<L> {
  return (metricsRegistry.getSingleMetric(name) as Counter<L> | undefined) ?? new Counter({ name, help, labelNames, registers: [metricsRegistry] });
}

/** A histogram in the shared registry (created once per process). */
export function histogram<L extends string>(name: string, help: string, labelNames: readonly L[], buckets: number[]): Histogram<L> {
  return (metricsRegistry.getSingleMetric(name) as Histogram<L> | undefined) ?? new Histogram({ name, help, labelNames, buckets, registers: [metricsRegistry] });
}

/** A gauge read at scrape time. Registered once per process; later calls replace the reading function. */
export function gaugeFrom(name: string, help: string, read: () => Promise<number> | number): void {
  const existing = metricsRegistry.getSingleMetric(name);
  if (existing) metricsRegistry.removeSingleMetric(name);
  new Gauge({
    name,
    help,
    registers: [metricsRegistry],
    async collect() {
      try {
        this.set(await read());
      } catch {
        // A failed reading leaves the last value; /readyz reports the dependency.
      }
    },
  });
}

const LAG_BUCKETS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 300];

export const metrics = {
  relayRequests: counter('brain_relay_requests_total', 'Relay HTTP requests, by endpoint and status', ['path', 'status']),
  relayReconnects: counter('brain_relay_reconnects_total', 'Relay WebSocket reconnects, by service', ['service']),
  relaySubscriptionsClosed: counter('brain_relay_subscriptions_closed_total', 'Subscriptions the relay closed, by service and reason', ['service', 'reason']),
  chatRequests: counter('brain_chat_requests_total', 'Mattermost API requests, by method and status', ['method', 'status']),
  chatReconnects: counter('brain_chat_reconnects_total', 'Mattermost WebSocket reconnects'),
  throttleWait: histogram('brain_throttle_wait_seconds', 'Time spent waiting for a write slot, by target', ['target'], [0.01, 0.05, 0.1, 0.5, 1, 5, 30]),
  mirrored: counter('brain_bridge_mirrored_total', 'Events mirrored by the bridge, by direction and kind', ['direction', 'kind']),
  mirrorLag: histogram('brain_bridge_mirror_lag_seconds', 'From an event at its source to its mirrored copy (history excluded)', ['direction'], LAG_BUCKETS),
  bridgeRetries: counter('brain_bridge_retries_total', 'Mirroring attempts retried, by direction', ['direction']),
  deadLetters: counter('brain_bridge_dead_letters_total', 'Mirroring given up after retries, by direction', ['direction']),
  jobs: counter('brain_runtime_jobs_total', 'Agent jobs finished, by outcome', ['outcome']),
  jobLatency: histogram('brain_runtime_reply_seconds', 'From the triggering message to the published reply', [], [0.5, 1, 2, 5, 10, 30, 60, 120]),
  llmTokens: counter('brain_runtime_llm_tokens_total', 'Model tokens, by direction', ['direction']),
  triggerSkips: counter('brain_runtime_trigger_skips_total', 'Mentions not answered, by reason', ['reason']),
  threadsIndexed: counter('brain_ingestion_threads_indexed_total', 'Threads (re)indexed'),
  documents: counter('brain_ingestion_documents_total', 'Brain documents written, by operation', ['op']),
  indexLag: histogram('brain_ingestion_index_lag_seconds', 'From the first change of a thread to its indexing', [], [1, 5, 10, 20, 30, 31, 32, 35, 40, 45, 60, 90, 120, 300, 600]),
};

export interface ReadinessCheck {
  name: string;
  check(): Promise<boolean> | boolean;
}

export interface OpsServer {
  readonly port: number;
  close(): Promise<void>;
}

/** Serve /healthz, /readyz and /metrics. Port 0 picks a free port (tests). */
export async function startOpsServer(options: { host: string; port: number; checks: ReadinessCheck[]; log: Logger }): Promise<OpsServer> {
  const { checks, log } = options;
  const server: Server = createServer((request, response) => {
    void (async () => {
      try {
        if (request.method !== 'GET') {
          response.writeHead(405).end();
        } else if (request.url === '/healthz') {
          response.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok\n');
        } else if (request.url === '/readyz') {
          const results = Object.fromEntries(
            await Promise.all(checks.map(async (item) => [item.name, await Promise.resolve(item.check()).catch(() => false)] as const)),
          );
          const ready = Object.values(results).every(Boolean);
          response.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' }).end(`${JSON.stringify({ ready, checks: results })}\n`);
        } else if (request.url === '/metrics') {
          response.writeHead(200, { 'Content-Type': metricsRegistry.contentType }).end(await metricsRegistry.metrics());
        } else {
          response.writeHead(404).end();
        }
      } catch (error) {
        log.error(errorFields(error), 'Operations endpoint failed');
        if (!response.headersSent) response.writeHead(500).end();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  log.info({ host: options.host, port }, 'Operations endpoint listening (/healthz, /readyz, /metrics)');
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
