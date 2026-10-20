// Cloudflare Worker: безопасный посредник между панелью владельца и GitHub.
//
// Секреты (хранятся только в Cloudflare → Settings → Variables and Secrets, в репозитории их нет):
//   GITHUB_TOKEN   — fine-grained токен GitHub: репозиторий ribay-steak-house, право Contents: Read and write
//   OWNER_CODE     — код владельца (то, что он вводит для входа)
//   SESSION_SECRET — случайная строка от 32 символов (подпись сессий)
// Необязательно (рекомендуется): привязка KV-хранилища с именем RL — счётчик неудачных попыток входа.
// Необязательно: ALLOWED_ORIGIN — адрес сайта, по умолчанию https://mogger112.github.io
//
// Сервер умеет ТОЛЬКО: прочитать меню, записать data/menu.csv и загрузить JPEG-фото в assets/img/uploads.
// Править другие файлы сайта через него нельзя, даже зная код.

const REPO = 'mogger112/ribay-steak-house';
const BRANCH = 'main';
const CSV_PATH = 'data/menu.csv';
const UPLOAD_DIR = 'assets/img/uploads';
const CSV_HEADER = 'Категория,Название,Цена,Фото,Показывать';

const SESSION_SECONDS = 30 * 24 * 3600;
const MAX_BODY_CHARS = 3000000;
const MAX_CSV_CHARS = 100000;
const MAX_CSV_LINES = 600;
const MAX_PHOTO_BYTES = 1500000;
const MAX_IP_FAILS = 5;
const MAX_ALL_FAILS = 40;
const FAIL_WINDOW_SECONDS = 900;

const enc = new TextEncoder();
const dec = new TextDecoder();
const memFails = new Map(); // запасной счётчик, если KV не подключён (на один экземпляр сервера)

// ---------- кодирование ----------
function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const toUrl = b64 => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromUrl = s => b64ToBytes(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));

// ---------- сессии (подписанные токены, без хранения на сервере) ----------
const hmacKey = secret => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

async function makeSession(env) {
  const payload = toUrl(bytesToB64(enc.encode(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS }))));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env.SESSION_SECRET), enc.encode(payload));
  return payload + '.' + toUrl(bytesToB64(new Uint8Array(sig)));
}

async function isLoggedIn(request, env) {
  const m = /^Bearer ([\w-]+)\.([\w-]+)$/.exec(request.headers.get('Authorization') || '');
  if (!m) return false;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(env.SESSION_SECRET), fromUrl(m[2]), enc.encode(m[1]));
    if (!ok) return false;
    const { exp } = JSON.parse(dec.decode(fromUrl(m[1])));
    return typeof exp === 'number' && exp > Date.now() / 1000;
  } catch (e) {
    return false;
  }
}

// Сравнение кода за одинаковое время (через хэши), чтобы по скорости ответа ничего нельзя было угадать
async function codeMatches(input, expected) {
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(input)),
    crypto.subtle.digest('SHA-256', enc.encode(expected))
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ---------- ограничение попыток входа ----------
async function getFails(env, key) {
  if (env.RL) return parseInt((await env.RL.get(key)) || '0', 10);
  const e = memFails.get(key);
  return e && e.exp > Date.now() ? e.n : 0;
}
async function addFail(env, key) {
  const n = (await getFails(env, key)) + 1;
  if (env.RL) await env.RL.put(key, String(n), { expirationTtl: FAIL_WINDOW_SECONDS });
  else memFails.set(key, { n, exp: Date.now() + FAIL_WINDOW_SECONDS * 1000 });
}
async function clearFails(env, key) {
  if (env.RL) await env.RL.delete(key); else memFails.delete(key);
}

// ---------- GitHub ----------
async function github(env, method, path, body) {
  const url = 'https://api.github.com/repos/' + REPO + '/contents/' + path + (method === 'GET' ? '?ref=' + BRANCH : '');
  const headers = {
    Authorization: 'Bearer ' + env.GITHUB_TOKEN,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ribay-admin-worker'
  };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch (e) { /* пустой ответ */ }
  return { ok: res.ok, status: res.status, data };
}

// ---------- проверки данных ----------
function validCsv(csv) {
  if (typeof csv !== 'string' || csv.length > MAX_CSV_CHARS) return false;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(csv)) return false;
  const lines = csv.split('\n');
  return lines.length <= MAX_CSV_LINES && lines[0].replace(/^﻿/, '').trim() === CSV_HEADER;
}

function randomName() {
  const r = crypto.getRandomValues(new Uint8Array(6));
  return 'p-' + Array.from(r, b => b.toString(16).padStart(2, '0')).join('') + '.jpg';
}

// ---------- HTTP ----------
function respond(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors)
  });
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return null;
  try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : null; } catch (e) { return null; }
}

export default {
  async fetch(request, env) {
    const allowed = env.ALLOWED_ORIGIN || 'https://mogger112.github.io';
    const origin = request.headers.get('Origin');
    if (origin && origin !== allowed) return new Response('Forbidden', { status: 403 });
    const cors = origin ? {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin'
    } : {};

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (!env.GITHUB_TOKEN || !env.OWNER_CODE || !env.SESSION_SECRET || env.SESSION_SECRET.length < 16) {
      return respond({ error: 'not-configured' }, 500, cors);
    }

    if (request.method !== 'GET' && parseInt(request.headers.get('Content-Length') || '0', 10) > MAX_BODY_CHARS + 1000000) {
      return respond({ error: 'too-large' }, 413, cors);
    }

    const route = request.method + ' ' + new URL(request.url).pathname;

    if (route === 'POST /login') {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const ipKey = 'fail:ip:' + ip, allKey = 'fail:all';
      if ((await getFails(env, ipKey)) >= MAX_IP_FAILS || (await getFails(env, allKey)) >= MAX_ALL_FAILS) {
        return respond({ error: 'too-many' }, 429, cors);
      }
      const body = await readJson(request);
      const code = body && typeof body.code === 'string' ? body.code.trim().slice(0, 100) : '';
      if (!(await codeMatches(code, env.OWNER_CODE))) {
        await addFail(env, ipKey);
        await addFail(env, allKey);
        return respond({ error: 'bad-code' }, 401, cors);
      }
      await clearFails(env, ipKey);
      return respond({ session: await makeSession(env) }, 200, cors);
    }

    if (!(await isLoggedIn(request, env))) return respond({ error: 'unauthorized' }, 401, cors);

    if (route === 'GET /menu') {
      const r = await github(env, 'GET', CSV_PATH);
      if (!r.ok || typeof r.data.content !== 'string') return respond({ error: 'github' }, 502, cors);
      return respond({ sha: r.data.sha, csv: dec.decode(b64ToBytes(r.data.content.replace(/\s/g, ''))) }, 200, cors);
    }

    if (route === 'PUT /menu') {
      const body = await readJson(request);
      if (!body || !validCsv(body.csv) || typeof body.sha !== 'string' || !/^[0-9a-f]{40}$/.test(body.sha)) {
        return respond({ error: 'bad-request' }, 400, cors);
      }
      const r = await github(env, 'PUT', CSV_PATH, {
        message: 'Панель владельца: обновление меню',
        content: bytesToB64(enc.encode(body.csv)),
        sha: body.sha,
        branch: BRANCH
      });
      if (r.status === 409 || r.status === 422) return respond({ error: 'conflict' }, 409, cors);
      if (!r.ok || !r.data.content) return respond({ error: 'github' }, 502, cors);
      return respond({ sha: r.data.content.sha }, 200, cors);
    }

    if (route === 'POST /photo') {
      const body = await readJson(request);
      const data = body && body.data;
      if (typeof data !== 'string' || data.length > 2200000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
        return respond({ error: 'bad-request' }, 400, cors);
      }
      let bytes;
      try { bytes = b64ToBytes(data); } catch (e) { return respond({ error: 'bad-request' }, 400, cors); }
      if (bytes.length > MAX_PHOTO_BYTES || bytes[0] !== 0xFF || bytes[1] !== 0xD8 || bytes[2] !== 0xFF) {
        return respond({ error: 'bad-photo' }, 400, cors);
      }
      const path = UPLOAD_DIR + '/' + randomName();
      const r = await github(env, 'PUT', path, { message: 'Панель владельца: фото блюда', content: data, branch: BRANCH });
      if (!r.ok) return respond({ error: 'github' }, 502, cors);
      return respond({ path }, 200, cors);
    }

    return respond({ error: 'not-found' }, 404, cors);
  }
};
