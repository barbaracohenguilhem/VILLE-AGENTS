import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import type { HouseConfig, ObjectConfig, ResidentConfig, VilleEvent } from './types.ts';
import { loadEnv } from './util/env.ts';
import { Simulation } from './world/simulation.ts';
import { Store } from './world/store.ts';

const ROOT = resolve(import.meta.dirname, '..');
loadEnv(ROOT);

const PUBLIC_DIR = join(ROOT, 'public');
const CONFIG_FILE = process.env.VILLE_CONFIG ? resolve(process.env.VILLE_CONFIG) : join(ROOT, 'config', 'house.json');
const STATE_FILE = process.env.VILLE_STATE ? resolve(process.env.VILLE_STATE) : join(ROOT, 'data', 'state.json');
const PORT = Number(process.env.PORT ?? 3000);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function loadConfig(): HouseConfig {
  const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as HouseConfig;
  if (!Array.isArray(cfg.rooms) || !Array.isArray(cfg.residents)) {
    throw new Error('config/house.json must have "rooms" and "residents" arrays');
  }
  return cfg;
}

const sim = new Simulation(loadConfig(), new Store(STATE_FILE));

// ── SSE ──────────────────────────────────────────────────────────────────────

const sseClients = new Set<ServerResponse>();

function sendSse(res: ServerResponse, type: string, data: unknown): void {
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

sim.onEvent((ev: VilleEvent) => {
  for (const res of sseClients) sendSse(res, 'ville', ev);
});

setInterval(() => {
  for (const res of sseClients) res.write(': ping\n\n');
}, 15_000).unref();

// ── helpers ──────────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
}

function serveStatic(pathname: string, res: ServerResponse): void {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  createReadStream(file).pipe(res);
}

// ── routes ───────────────────────────────────────────────────────────────────

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/api/state') return json(res, 200, sim.snapshot());

  if (method === 'GET' && path === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    sendSse(res, 'snapshot', sim.snapshot());
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (method === 'GET' && path.startsWith('/api/resident/')) {
    const name = decodeURIComponent(path.slice('/api/resident/'.length));
    const detail = sim.detail(name);
    return detail ? json(res, 200, detail) : json(res, 404, { error: `no resident named ${name}` });
  }

  if (method === 'POST' && path === '/api/control') {
    const body = await readBody(req);
    switch (body.action) {
      case 'play':
        sim.start();
        break;
      case 'pause':
        sim.pause();
        break;
      case 'step':
        if (!sim.running) void sim.step();
        break;
      case 'speed':
        sim.setSpeed(Number(body.value) || 1);
        break;
      default:
        return json(res, 400, { error: 'unknown action' });
    }
    return json(res, 200, { running: sim.running, speed: sim.speed });
  }

  if (method === 'POST' && path === '/api/human/say') {
    const body = await readBody(req);
    const text = typeof body.text === 'string' ? body.text : '';
    const to = typeof body.to === 'string' ? body.to : undefined;
    if (!text.trim()) return json(res, 400, { error: 'empty message' });
    // Don't block the HTTP response on the resident's reply; it arrives via SSE.
    void sim.humanSay(text, to).catch((err: Error) => console.error('[human]', err.message));
    return json(res, 202, { ok: true });
  }

  if (method === 'POST' && path === '/api/human/move') {
    const body = await readBody(req);
    if (typeof body.room !== 'string') return json(res, 400, { error: 'room required' });
    sim.humanMove(body.room);
    return json(res, 200, { room: sim.human.room });
  }

  if (method === 'POST' && path === '/api/human/walk') {
    const body = await readBody(req);
    const x = Number(body.x);
    const y = Number(body.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return json(res, 400, { error: 'x and y required' });
    const ok = sim.humanWalk(x, y);
    return json(res, ok ? 200 : 400, ok ? { ok: true } : { error: "can't walk there" });
  }

  if (method === 'POST' && path === '/api/human/name') {
    const body = await readBody(req);
    if (typeof body.name !== 'string') return json(res, 400, { error: 'name required' });
    sim.setHumanName(body.name);
    return json(res, 200, { name: sim.human.name });
  }

  if (method === 'POST' && path === '/api/residents/save') {
    const body = await readBody(req);
    const resident = body.resident as (Partial<ResidentConfig> & { name?: string }) | undefined;
    if (!resident || typeof resident.name !== 'string') return json(res, 400, { error: 'resident.name required' });
    try {
      sim.saveResidentConfig(resident as Partial<ResidentConfig> & { name: string });
      if (body.persist) {
        sim.flush();
        writeFileSync(CONFIG_FILE, JSON.stringify(sim.cfg, null, 2) + '\n');
      }
      const snap = sim.snapshot();
      for (const client of sseClients) sendSse(client, 'snapshot', snap);
      return json(res, 200, snap);
    } catch (err) {
      return json(res, 400, { error: (err as Error).message });
    }
  }

  if (method === 'POST' && path === '/api/rooms/object') {
    const body = await readBody(req);
    const roomId = typeof body.room === 'string' ? body.room : '';
    const action = body.action as 'add' | 'remove' | 'description';
    if (!roomId || !['add', 'remove', 'description'].includes(action)) {
      return json(res, 400, { error: 'room and valid action required' });
    }
    try {
      sim.updateRoomObjects(roomId, action, {
        object: body.object as ObjectConfig | undefined,
        index: typeof body.index === 'number' ? body.index : undefined,
        description: typeof body.description === 'string' ? body.description : undefined,
      });
      if (body.persist) {
        sim.flush();
        writeFileSync(CONFIG_FILE, JSON.stringify(sim.cfg, null, 2) + '\n');
      }
      const snap = sim.snapshot();
      for (const client of sseClients) sendSse(client, 'snapshot', snap);
      return json(res, 200, snap);
    } catch (err) {
      return json(res, 400, { error: (err as Error).message });
    }
  }

  if (method === 'GET') return serveStatic(path, res);
  json(res, 405, { error: 'method not allowed' });
}

const server = createServer((req, res) => {
  route(req, res).catch((err: Error) => {
    console.error('[http]', err.message);
    if (!res.headersSent) json(res, 500, { error: err.message });
    else res.end();
  });
});

server.listen(PORT, () => {
  const live = sim.residents.filter((r) => r.llm.mode === 'live').length;
  const demo = sim.residents.filter((r) => r.llm.mode === 'demo').length;
  const unavailable = sim.residents.length - live - demo;
  console.log(`\n  🏡  Ville — "${sim.house.name}"`);
  console.log(`  →  http://localhost:${PORT}`);
  console.log(`  ${sim.residents.length} residents · ${live} live providers (not yet checked) · ${demo} scripted demos · ${unavailable} need setup`);
  for (const r of sim.residents) {
    console.log(`     ${r.cfg.emoji} ${r.name.padEnd(10)} ${r.llm.label}`);
  }
  console.log('');
  if (process.env.VILLE_AUTOSTART !== '0') sim.start();
});

function shutdown(): void {
  console.log('\n  saving the house…');
  sim.pause();
  sim.flush();
  for (const res of sseClients) res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
