// ДЕМО-РЕЖИМ панели владельца (временный). Чтобы убрать: удалите этот файл и строку <script src="js/admin-demo.js"> в admin.html.
// Работает только там, где настоящий сервер (api.php) не подключён, и ничего реально не меняет:
// правки живут только во вкладке браузера (sessionStorage) и пропадают при её закрытии.
window.RIBAY_DEMO = (function () {
  'use strict';
  const FLAG = 'ribay_demo';
  const CSV_KEY = 'ribay_demo_csv';
  const VER_KEY = 'ribay_demo_ver';
  let photoCounter = 0;

  function get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* ничего */ } }
  function del(k) { try { sessionStorage.removeItem(k); } catch (e) { /* ничего */ } }
  function fail(code, status) { const e = new Error(code); e.code = code; e.status = status; return e; }

  async function sampleCsv() {
    const res = await fetch('data/menu.csv', { cache: 'no-store' });
    if (!res.ok) throw fail('read-failed', 500);
    return res.text();
  }

  return {
    code: 'demo',
    isActive() { return get(FLAG) === '1'; },
    async handle(action, options) {
      const method = (options && options.method) || 'GET';
      const body = options && options.body ? JSON.parse(options.body) : {};
      const route = method + ' ' + action;
      if (route === 'GET state') return this.isActive() ? { loggedIn: true, csrf: 'demo' } : { loggedIn: false };
      if (route === 'POST login') { set(FLAG, '1'); return { csrf: 'demo' }; }
      if (route === 'POST logout') { del(FLAG); del(CSV_KEY); del(VER_KEY); return { ok: true }; }
      if (!this.isActive()) throw fail('unauthorized', 401);
      if (route === 'GET menu') {
        return { csv: get(CSV_KEY) || await sampleCsv(), version: get(VER_KEY) || '0' };
      }
      if (route === 'POST menu') {
        if (typeof body.csv !== 'string' || !body.csv.startsWith('Категория,Название,Цена,Фото,Показывать')) throw fail('bad-request', 400);
        const ver = String(parseInt(get(VER_KEY) || '0', 10) + 1);
        set(CSV_KEY, body.csv); set(VER_KEY, ver);
        return { version: ver };
      }
      if (route === 'POST photo') {
        photoCounter++;
        return { path: 'assets/img/uploads/demo-' + photoCounter + '.jpg' };
      }
      throw fail('not-found', 404);
    }
  };
})();
