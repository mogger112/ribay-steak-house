'use strict';
// Подключение логики панели владельца (api/_owner-core.js) к функциям Vercel.
// Адрес на сайте: /api/owner?action=...
const crypto = require('node:crypto');
const { createOwnerApi } = require('./_owner-core.js');

const MAX_BODY_BYTES = 3000000;

const deps = {
  hmacHex: async (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('hex'),
  sha256Hex: async text => crypto.createHash('sha256').update(text).digest('hex'),
  randomHex: bytes => crypto.randomBytes(bytes).toString('hex'),
  timingSafeEqualHex: (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  },
  fetch: (...args) => fetch(...args),
  now: () => Date.now()
};

const handle = createOwnerApi(deps);

async function readBody(req) {
  const declared = parseInt(req.headers['content-length'] || '0', 10);
  if (declared > MAX_BODY_BYTES) return { tooLarge: true };
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) return { tooLarge: true };
    chunks.push(chunk);
  }
  if (total === 0 && req.body !== undefined && req.body !== null) {
    // Запасной путь: платформа уже прочитала тело запроса сама
    if (typeof req.body === 'string') return { body: req.body };
    if (Buffer.isBuffer(req.body)) return { body: req.body.toString('utf8') };
    return { body: JSON.stringify(req.body) };
  }
  return { body: Buffer.concat(chunks).toString('utf8') };
}

function clientIp(req) {
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real) return real.trim().slice(0, 64);
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim().slice(0, 64);
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

module.exports = async function owner(req, res) {
  let out;
  try {
    const url = new URL(req.url, 'http://localhost');
    const request = {
      method: req.method,
      action: url.searchParams.get('action') || '',
      headers: req.headers,
      ip: clientIp(req)
    };
    if (req.method === 'POST') Object.assign(request, await readBody(req));
    out = await handle(request, process.env);
  } catch (e) {
    out = { status: 500, json: { error: 'server' }, cookies: [] };
  }
  res.statusCode = out.status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (out.cookies.length) res.setHeader('Set-Cookie', out.cookies);
  res.end(JSON.stringify(out.json));
};
