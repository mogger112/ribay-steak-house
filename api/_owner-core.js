'use strict';
// Логика панели владельца для Vercel. Файлы с «_» в начале папки api/ Vercel не публикует как адреса.
// Здесь нет обращений к Node напрямую: всё нужное (подписи, случайные числа, сеть) приходит через deps,
// поэтому этот файл можно проверять и в браузере. Подключение к Vercel — в api/owner.js.
//
// Настройки (Vercel → Project → Settings → Environment Variables), в репозитории их нет:
//   GITHUB_TOKEN   — fine-grained токен GitHub: репозиторий сайта, право Contents: Read and write
//   OWNER_CODE     — код владельца
//   SESSION_SECRET — случайная строка от 32 символов (подпись сессий)
//   GITHUB_REPO    — необязательно, по умолчанию mogger112/ribay-steak-house
//   GITHUB_BRANCH  — необязательно, по умолчанию main
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (или KV_REST_API_URL / KV_REST_API_TOKEN) — необязательно:
//                    общий счётчик неудачных входов (рекомендуется)
//
// Через эту функцию можно ТОЛЬКО: войти по коду, прочитать меню, сохранить data/menu.csv и загрузить JPEG
// в assets/img/uploads. Другие файлы сайта она менять не умеет.

const DEFAULT_REPO = 'mogger112/ribay-steak-house';
const DEFAULT_BRANCH = 'main';
const CSV_PATH = 'data/menu.csv';
const UPLOAD_DIR = 'assets/img/uploads';
const CSV_HEADER = 'Категория,Название,Цена,Фото,Показывать';
const COOKIE = 'ribay_owner';
const REMEMBER_SECONDS = 30 * 24 * 3600;
const SHORT_SESSION_SECONDS = 12 * 3600;
const FAIL_WINDOW = 900;
const MAX_IP_FAILS = 5;
const MAX_ALL_FAILS = 40;
const MAX_CSV_CHARS = 100000;
const MAX_CSV_LINES = 600;
const MAX_PHOTO_BYTES = 1500000;
const MAX_PHOTO_SIDE = 4000;

function createOwnerApi(deps) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const memory = new Map(); // запасной счётчик попыток (на один экземпляр функции)

  const reply = (status, json, cookies) => ({ status, json, cookies: cookies || [] });
  const fail = (code, status) => reply(status, { error: code });

  // ---------- кодирование ----------
  const toB64Url = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const fromB64Url = s => atob(s.replace(/-/g, '+').replace(/_/g, '/'));
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

  // ---------- сессия: подписанная cookie без хранения на сервере ----------
  function parseCookies(header) {
    const out = {};
    String(header || '').split(';').forEach(part => {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    });
    return out;
  }

  async function makeSession(env, remember) {
    const ttl = remember ? REMEMBER_SECONDS : SHORT_SESSION_SECONDS;
    const sid = deps.randomHex(16);
    const payload = toB64Url(JSON.stringify({ sid, exp: Math.floor(deps.now() / 1000) + ttl }));
    const sig = await deps.hmacHex(env.SESSION_SECRET, 'session:' + payload);
    const age = remember ? '; Max-Age=' + REMEMBER_SECONDS : '';
    return {
      sid,
      cookie: COOKIE + '=' + payload + '.' + sig + '; Path=/; HttpOnly; Secure; SameSite=Strict' + age
    };
  }

  const clearCookie = () => COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0';

  async function readSession(req, env) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 2 || !/^[\w-]+$/.test(parts[0]) || !/^[0-9a-f]{64}$/.test(parts[1])) return null;
    const expected = await deps.hmacHex(env.SESSION_SECRET, 'session:' + parts[0]);
    if (!deps.timingSafeEqualHex(expected, parts[1])) return null;
    let data;
    try { data = JSON.parse(fromB64Url(parts[0])); } catch (e) { return null; }
    if (!data || typeof data.sid !== 'string' || typeof data.exp !== 'number' || data.exp < deps.now() / 1000) return null;
    return { sid: data.sid, csrf: await deps.hmacHex(env.SESSION_SECRET, 'csrf:' + data.sid) };
  }

  // ---------- ограничение попыток входа ----------
  function rateStore(env) {
    const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
    const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
    if (url && token) {
      const run = async args => {
        try {
          const r = await deps.fetch(url.replace(/\/$/, ''), {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify(args)
          });
          return (await r.json()).result;
        } catch (e) { return null; } // сбой хранилища не должен запирать владельца
      };
      return {
        count: async k => parseInt((await run(['GET', k])) || '0', 10) || 0,
        add: async k => { await run(['INCR', k]); await run(['EXPIRE', k, FAIL_WINDOW]); },
        clear: async k => { await run(['DEL', k]); }
      };
    }
    return {
      count: async k => { const e = memory.get(k); return e && e.exp > deps.now() ? e.n : 0; },
      add: async k => { const e = memory.get(k); const n = e && e.exp > deps.now() ? e.n + 1 : 1; memory.set(k, { n, exp: deps.now() + FAIL_WINDOW * 1000 }); },
      clear: async k => { memory.delete(k); }
    };
  }

  // ---------- GitHub ----------
  async function github(env, method, path, body) {
    const repo = env.GITHUB_REPO || DEFAULT_REPO;
    const branch = env.GITHUB_BRANCH || DEFAULT_BRANCH;
    const url = 'https://api.github.com/repos/' + repo + '/contents/' + path + (method === 'GET' ? '?ref=' + branch : '');
    const headers = {
      Authorization: 'Bearer ' + env.GITHUB_TOKEN,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ribay-owner-panel'
    };
    if (body) headers['Content-Type'] = 'application/json';
    const res = await deps.fetch(url, { method, headers, body: body ? JSON.stringify(Object.assign({ branch }, body)) : undefined });
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

  // Размеры JPEG из его заголовка (без сторонних библиотек)
  function jpegSize(b) {
    if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return null;
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xFF) return null;
      const m = b[i + 1];
      if (m === 0xFF) { i++; continue; }
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
      if (m === 0xD9) return null;
      const len = (b[i + 2] << 8) | b[i + 3];
      if (len < 2) return null;
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
      }
      i += 2 + len;
    }
    return null;
  }

  function parseJsonBody(req) {
    if (req.tooLarge) return { err: fail('too-large', 413) };
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return { err: fail('bad-request', 415) };
    try {
      const v = JSON.parse(req.body);
      if (v && typeof v === 'object' && !Array.isArray(v)) return { data: v };
    } catch (e) { /* ниже */ }
    return { err: fail('bad-request', 400) };
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------- главный обработчик ----------
  return async function handle(req, env) {
    // Лишние пробелы и переводы строк при вставке значений в настройки Vercel не должны ломать вход
    const ownerCode = String(env.OWNER_CODE || '').trim();
    if (!String(env.GITHUB_TOKEN || '').trim() || !ownerCode || String(env.SESSION_SECRET || '').trim().length < 32) {
      return fail('not-configured', 500);
    }
    env = Object.assign({}, env, {
      OWNER_CODE: ownerCode,
      GITHUB_TOKEN: String(env.GITHUB_TOKEN).trim(),
      SESSION_SECRET: String(env.SESSION_SECRET).trim()
    });
    const route = req.method + ' ' + req.action;

    if (route === 'GET state') {
      const s = await readSession(req, env);
      return reply(200, s ? { loggedIn: true, csrf: s.csrf } : { loggedIn: false });
    }

    if (route === 'POST login') {
      const store = rateStore(env);
      const ipKey = 'ribay:fail:ip:' + req.ip, allKey = 'ribay:fail:all';
      if ((await store.count(ipKey)) >= MAX_IP_FAILS || (await store.count(allKey)) >= MAX_ALL_FAILS) {
        return fail('too-many', 429);
      }
      const p = parseJsonBody(req);
      if (p.err) return p.err;
      const code = typeof p.data.code === 'string' ? p.data.code.trim().slice(0, 100) : '';
      const [a, b] = await Promise.all([deps.sha256Hex(code), deps.sha256Hex(env.OWNER_CODE)]);
      if (!deps.timingSafeEqualHex(a, b)) {
        await store.add(ipKey);
        await store.add(allKey);
        await sleep(300);
        return fail('bad-code', 401);
      }
      await store.clear(ipKey);
      const session = await makeSession(env, !!p.data.remember);
      return reply(200, { csrf: await deps.hmacHex(env.SESSION_SECRET, 'csrf:' + session.sid) }, [session.cookie]);
    }

    if (route === 'POST logout') return reply(200, { ok: true }, [clearCookie()]);

    // Дальше — только для вошедшего владельца
    const session = await readSession(req, env);
    if (!session) return fail('unauthorized', 401);
    if (req.method === 'POST') {
      const sent = String(req.headers['x-csrf-token'] || '');
      if (!deps.timingSafeEqualHex(session.csrf, sent)) return fail('unauthorized', 403);
    }

    if (route === 'GET menu') {
      const r = await github(env, 'GET', CSV_PATH);
      if (!r.ok || typeof r.data.content !== 'string') return fail('github', 502);
      return reply(200, { csv: dec.decode(b64ToBytes(r.data.content.replace(/\s/g, ''))), version: r.data.sha });
    }

    if (route === 'POST menu') {
      const p = parseJsonBody(req);
      if (p.err) return p.err;
      const { csv, version } = p.data;
      if (!validCsv(csv) || typeof version !== 'string' || !/^[0-9a-f]{40}$/.test(version)) return fail('bad-request', 400);
      const r = await github(env, 'PUT', CSV_PATH, {
        message: 'Панель владельца: обновление меню',
        content: bytesToB64(enc.encode(csv)),
        sha: version
      });
      if (r.status === 409 || r.status === 422) return fail('conflict', 409);
      if (!r.ok || !r.data.content) return fail('github', 502);
      return reply(200, { version: r.data.content.sha });
    }

    if (route === 'POST photo') {
      const p = parseJsonBody(req);
      if (p.err) return p.err;
      const data = p.data.data;
      if (typeof data !== 'string' || data.length > 2200000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return fail('bad-request', 400);
      let bytes;
      try { bytes = b64ToBytes(data); } catch (e) { return fail('bad-request', 400); }
      const size = bytes.length <= MAX_PHOTO_BYTES ? jpegSize(bytes) : null;
      if (!size || size.w < 1 || size.h < 1 || size.w > MAX_PHOTO_SIDE || size.h > MAX_PHOTO_SIDE) return fail('bad-photo', 400);
      const path = UPLOAD_DIR + '/p-' + deps.randomHex(6) + '.jpg';
      const r = await github(env, 'PUT', path, { message: 'Панель владельца: фото блюда', content: data });
      if (!r.ok) return fail('github', 502);
      return reply(200, { path });
    }

    return fail('not-found', 404);
  };
}

module.exports = { createOwnerApi };
