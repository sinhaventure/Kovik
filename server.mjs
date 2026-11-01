// ============================================================================
//  KOVIK INTELLIGENCE  -  portable runner
//
//  Runs the exact same worker file outside Cloudflare: on a VPS, on Node,
//  on Deno, on Bun, on Render/Railway/Fly, or locally on your laptop.
//
//  Usage:
//      node server.mjs
//      PORT=3000 node server.mjs
//
//  Environment variables (same names as the Cloudflare dashboard):
//      GEMINI_KEY, GMAIL_USER, GMAIL_APP_PASSWORD, BREVO_KEY, MAIL_FROM,
//      DAILY_LIMIT, MAX_PAGES, ADMIN_EMAIL, WATERMARK_URL
//
//  Storage: a JSON file on disk (./data/kv.json). Same interface Cloudflare KV
//  gives the worker, so no application code changes.
//
//  Notes
//    - Gmail SMTP needs Cloudflare's TCP socket API, which does not exist here.
//      On this runner email goes through BREVO_KEY instead. Set that variable.
//    - The published sites are served from /s/<slug>/ exactly as on Cloudflare.
// ============================================================================

import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Accept either filename so the repo works whatever it was uploaded as.
function resolveWorkerPath() {
  if (process.env.WORKER_PATH) return process.env.WORKER_PATH;

  // Known names first, then any other .js in the folder - so the app works
  // whatever the file ended up being called when it was downloaded.
  const preferred = ['_worker.js', 'worker.js', 'kovik.js', 'kovik-intelligence.js', 'app.js', 'index.js'];
  for (const name of preferred) {
    const candidate = path.join(HERE, name);
    if (fs.existsSync(candidate)) return candidate;
  }

  const skip = new Set(['server.mjs', 'server.js']);
  const found = fs.readdirSync(HERE).filter((f) => f.endsWith('.js') && !skip.has(f));
  if (found.length) return path.join(HERE, found[0]);

  return path.join(HERE, '_worker.js');
}

const WORKER_PATH = resolveWorkerPath();
const DATA_DIR = process.env.DATA_DIR || path.join(HERE, 'data');
const KV_FILE = path.join(DATA_DIR, 'kv.json');

// ---------------------------------------------------------------------------
//  File-backed KV with the same shape as Cloudflare KV
// ---------------------------------------------------------------------------
class FileKV {
  constructor(file) {
    this.file = file;
    this.data = {};
    this.dirty = false;
    this.load();
    this.timer = setInterval(() => this.flush(), 2000);
    if (this.timer.unref) this.timer.unref();
  }

  load() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (fs.existsSync(this.file)) {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      }
    } catch (err) {
      console.error('[kv] could not read store, starting empty:', err.message);
      this.data = {};
    }
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[kv] write failed:', err.message);
    }
  }

  expired(rec) {
    return rec && rec.exp && Date.now() > rec.exp;
  }

  async get(key) {
    const rec = this.data[key];
    if (!rec) return null;
    if (this.expired(rec)) {
      delete this.data[key];
      this.dirty = true;
      return null;
    }
    return rec.v;
  }

  async put(key, value, options) {
    const ttl = options && options.expirationTtl;
    this.data[key] = {
      v: String(value),
      exp: ttl ? Date.now() + ttl * 1000 : 0
    };
    this.dirty = true;
  }

  async delete(key) {
    delete this.data[key];
    this.dirty = true;
  }

  async list() {
    return { keys: Object.keys(this.data).map((name) => ({ name })) };
  }
}


// ---------------------------------------------------------------------------
//  Gmail SMTP over plain Node sockets
//  The worker's SMTP client takes an injectable socket, so the exact same
//  protocol code that runs on Cloudflare runs here too - just over node:net.
// ---------------------------------------------------------------------------
function wrapNodeSocket(sock) {
  const dec = new TextDecoder();
  const queue = [];
  let ended = false;
  let wake = null;

  const push = () => { if (wake) { const w = wake; wake = null; w(); } };

  sock.on('data', (chunk) => { queue.push(dec.decode(chunk, { stream: true })); push(); });
  sock.on('end', () => { ended = true; push(); });
  sock.on('close', () => { ended = true; push(); });
  sock.on('error', () => { ended = true; push(); });

  const api = {
    async write(text) {
      await new Promise((resolve, reject) => {
        sock.write(text, (err) => (err ? reject(err) : resolve()));
      });
    },
    async read() {
      while (!queue.length && !ended) {
        await new Promise((resolve) => { wake = resolve; });
      }
      if (!queue.length) return null;
      return queue.shift();
    },
    async startTls() {
      return await new Promise((resolve, reject) => {
        const secure = tls.connect({ socket: sock, servername: 'smtp.gmail.com' }, () => {
          resolve(wrapNodeSocket(secure));
        });
        secure.once('error', reject);
      });
    },
    close() {
      try { sock.destroy(); } catch (e) {}
    }
  };
  return api;
}

export function nodeSocket(host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port }, () => {
      sock.setTimeout(30000, () => sock.destroy(new Error('socket timed out')));
      resolve(wrapNodeSocket(sock));
    });
    sock.once('error', reject);
  });
}

// ---------------------------------------------------------------------------
//  Node request -> Web Request, Web Response -> Node response
// ---------------------------------------------------------------------------
// The worker only ever uses url, method, headers.get() and json()/text(),
// so a small duck-typed request is enough - and it avoids depending on the
// runtime's HTTP client implementation.
function toWorkerRequest(req, base) {
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    req.on('data', (c) => chunks.push(c));
    req.on('end', resolve);
    req.on('error', reject);
  });

  const readBody = async () => {
    await done;
    return chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
  };

  return {
    url: base + req.url,
    method: (req.method || 'GET').toUpperCase(),
    headers: {
      get(name) {
        const v = req.headers[String(name).toLowerCase()];
        return v === undefined ? null : Array.isArray(v) ? v.join(', ') : v;
      }
    },
    json: async () => JSON.parse(await readBody()),
    text: readBody
  };
}

async function sendWebResponse(res, webRes) {
  const headers = {};
  webRes.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(webRes.status, headers);
  if (!webRes.body) return res.end();
  const reader = webRes.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

// ---------------------------------------------------------------------------
//  Server
// ---------------------------------------------------------------------------
// Builds the environment (file-backed storage + process env) without
// starting a listener - handy for tests and for embedding in another server.
export async function createEnv(envOverrides = {}) {
  const kv = new FileKV(KV_FILE);
  return {
    kv,
    env: {
      ...process.env,
      ...envOverrides,
      SITES: kv,
      // lets the worker send Gmail SMTP on this runtime too
      __openSocket: nodeSocket
    }
  };
}

export async function createServer(envOverrides = {}) {
  const worker = (await import(WORKER_PATH)).default;
  const { env, kv } = await createEnv(envOverrides);

  const server = http.createServer(async (req, res) => {
    const host = req.headers.host || 'localhost';
    const proto = req.headers['x-forwarded-proto'] || 'http';
    try {
      const webReq = toWorkerRequest(req, proto + '://' + host);
      const webRes = await worker.fetch(webReq, env);
      await sendWebResponse(res, webRes);
    } catch (err) {
      console.error('[server]', err);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error' }));
    }
  });

  server.on('close', () => { kv.flush(); clearInterval(kv.timer); });
  return { server, env, kv };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '0.0.0.0';
  const { server } = await createServer();

  server.on('error', (err) => {
    console.error('server error:', err && (err.stack || err.message || err));
    if (err && err.code === 'EADDRINUSE') {
      console.error('Port ' + port + ' is already in use.');
    }
    process.exit(1);
  });

  server.listen(port, host, () => {
    console.log('Kovik Intelligence listening on http://' + host + ':' + port);
    console.log('Data file: ' + KV_FILE);
    console.log('Worker file: ' + WORKER_PATH);
    if (!process.env.GEMINI_KEY) {
      console.log('No GEMINI_KEY in the environment - log in and paste it in the Admin panel instead.');
    }
  });

  const stop = () => { server.close(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
