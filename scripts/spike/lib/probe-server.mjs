// A tiny HTTP probe for the Mattermost integration spikes (B1). It runs inside a container on the stack's
// network, so Mattermost reaches it by name exactly as it will reach the brain API, and it records every
// request it gets. Plain JavaScript: it runs with node alone, without tsx. Responses imitate what the brain
// API will answer: an ephemeral text for commands, an empty object for dialog submissions, an ephemeral
// text for post actions.
import { createServer } from 'node:http';

const port = Number(process.env.PROBE_PORT ?? 9121);
const received = [];

function parseBody(contentType, text) {
  if (!text) return undefined;
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (contentType.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  return text;
}

createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'probe'}`);
    const contentType = String(request.headers['content-type'] ?? '');
    const send = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/_health') return send(200, { ok: true });
    if (url.pathname === '/_received') {
      if (request.method === 'DELETE') received.length = 0;
      return send(200, received);
    }
    received.push({
      at: Date.now(),
      method: request.method,
      path: url.pathname,
      contentType,
      headers: { 'user-agent': request.headers['user-agent'], authorization: request.headers.authorization },
      body: parseBody(contentType, Buffer.concat(chunks).toString('utf8')),
    });
    if (url.pathname.startsWith('/mm/commands/')) return send(200, { response_type: 'ephemeral', text: `probe got /${url.pathname.split('/').pop()}` });
    if (url.pathname.startsWith('/mm/dialogs/')) return send(200, {});
    if (url.pathname.startsWith('/mm/actions/')) return send(200, { ephemeral_text: 'probe got the action' });
    return send(404, { error: 'not found' });
  });
}).listen(port, '0.0.0.0', () => console.log(`probe listening on ${port}`));
