/**
 * Dashboard HTTP server.
 * Receives JSON snapshots via POST /api/ingest.
 * Serves dashboard UI and API endpoints.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from '../log.js';
import { setSnapshot, addLogClient, removeLogClient, pushLogLines } from './store.js';
import { dispatch } from './router.js';
import type { DashboardConfig, DashboardSnapshot } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = path.resolve(__dirname, '../../src/dashboard/fonts');

const DEFAULT_PORT = 3100;

let server: http.Server | null = null;
let dashboardSecret: string | null = null;

export function getDashboardSecret(): string | null {
  return dashboardSecret;
}

export function setDashboardSecret(secret: string | null): void {
  dashboardSecret = secret;
}

export function startDashboard(config: DashboardConfig = {}): void {
  const port = config.port || DEFAULT_PORT;
  dashboardSecret = config.secret || null;

  if (!dashboardSecret) {
    log.warn('Dashboard starting without secret — endpoints are unauthenticated');
  }

  server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;
    const method = req.method || 'GET';

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth check for /api/* routes (endpoints with their own auth are excluded)
    const selfAuthed = ['/api/ingest', '/api/logs', '/api/logs/push'];
    if (path.startsWith('/api/') && !selfAuthed.includes(path) && dashboardSecret) {
      const auth = req.headers.authorization;
      if (!auth || auth !== `Bearer ${dashboardSecret}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    // Ingest endpoint — receives JSON snapshots from NanoClaw
    if (path === '/api/ingest' && method === 'POST') {
      await handleIngest(req, res);
      return;
    }

    // Log push — receives log lines from NanoClaw pusher
    if (path === '/api/logs/push' && method === 'POST') {
      await handleLogPush(req, res);
      return;
    }

    // Log SSE stream — browser connects here
    if (path === '/api/logs' && method === 'GET') {
      handleLogStream(req, res);
      return;
    }

    // Serve self-hosted fonts
    if (path.startsWith('/fonts/') && method === 'GET') {
      const fontName = path.slice('/fonts/'.length).replace(/[^a-zA-Z0-9._-]/g, '');
      if (!fontName || fontName.includes('..')) {
        res.writeHead(400);
        res.end();
        return;
      }
      const fontPath = `${FONTS_DIR}/${fontName}`;
      try {
        const data = fs.readFileSync(fontPath);
        const ext = fontName.split('.').pop() || '';
        const mimeTypes: Record<string, string> = {
          woff2: 'font/woff2',
          woff: 'font/woff',
          ttf: 'font/ttf',
          otf: 'font/otf',
        };
        res.writeHead(200, {
          'Content-Type': mimeTypes[ext] ?? 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000, immutable',
        });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end();
      }
      return;
    }

    try {
      await dispatch(method, path, url.searchParams, res, req);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      }
    }
  });

  server.listen(port, '0.0.0.0', () => {
    log.info('Dashboard listening', { url: `http://localhost:${port}/dashboard` });
  });
}

export async function stopDashboard(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
}

async function handleIngest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // Auth check for ingest
  if (dashboardSecret) {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${dashboardSecret}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }

  try {
    const data = JSON.parse(Buffer.concat(chunks).toString()) as DashboardSnapshot;
    setSnapshot(data);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, timestamp: data.timestamp }));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
  }
}

async function handleLogPush(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (dashboardSecret) {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${dashboardSecret}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }

  try {
    const { lines } = JSON.parse(Buffer.concat(chunks).toString()) as { lines: string[] };
    pushLogLines(lines);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, count: lines.length }));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
  }
}

function handleLogStream(req: http.IncomingMessage, res: http.ServerResponse): void {
  // Auth check — read token from query param since SSE can't set headers
  if (dashboardSecret) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const token = url.searchParams.get('token') || req.headers.authorization?.replace('Bearer ', '');
    if (!token || token !== dashboardSecret) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('event: ping\ndata: connected\n\n');

  addLogClient(res);
  req.on('close', () => removeLogClient(res));
}
