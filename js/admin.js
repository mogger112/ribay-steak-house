// Панель владельца: правит меню и загружает фото через наш сервер (worker/index.js).
// В браузере хранится только временная подписанная сессия — ключей GitHub здесь нет.
(() => {
  'use strict';

  // Адрес сервера (Cloudflare Worker), например 'https://ribay-admin.ИМЯ.workers.dev'. Пусто — вход ещё не подключён.
  const WORKER_URL = '';
  const SESSION_KEY = 'ribay_admin_session';
  const MAX_PHOTO_BYTES = 30 * 1024 * 1024;
  const MAX_SIDE = 1200;

  const $ = id => document.getElementById(id);

  // Открыто как окно поверх сайта: прячем ссылки, ведущие на сайт, и закрываем окно по Esc
  if (new URLSearchParams(location.search).get('embed') === '1' && window.parent !== window) {
    document.body.classList.add('admin--embed');
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') window.parent.postMessage({ type: 'ribay-owner-close' }, location.origin);
    });
  }

  const store = {
    get() { try { return localStorage.getItem(SESSION_KEY); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem(SESSION_KEY, v); } catch (e) { /* приватный режим */ } },
    clear() { try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ничего */ } }
  };
  // Старые ключи прошлых версий панели больше не нужны
  try { localStorage.removeItem('ribay_admin_token'); } catch (e) { /* ничего */ }

  let session = null, csvSha = null, dishes = [], uid = 0, dirty = false, saving = false;
  let addFile = null, addPreviewUrl = null;

  // ---------- маленький помощник для DOM (весь текст — только через textContent) ----------
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'value') e.value = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    });
    kids.flat().forEach(c => { if (c) e.appendChild(c); });
    return e;
  }

  // ---------- запросы к нашему серверу ----------
  async function api(path, options) {
    options = options || {};
    if (!WORKER_URL) { const e = new Error('not-configured'); e.code = 'not-configured'; throw e; }
    const headers = {};
    if (session) headers.Authorization = 'Bearer ' + session;
    if (options.body) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(WORKER_URL.replace(/\/$/, '') + path, Object.assign({}, options, { headers, cache: 'no-store' }));
    } catch (e) {
      const err = new Error('network'); err.code = 'network'; throw err;
    }
    let data = {};
    try { data = await res.json(); } catch (e) { /* пустой ответ */ }
    if (!res.ok) {
      const err = new Error(data.error || 'HTTP ' + res.status);
      err.status = res.status; err.code = data.error || null;
      throw err;
    }
    return data;
  }

  function explain(err) {
    if (err.code === 'network') return 'Нет связи с интернетом или с сервером. Проверьте подключение и попробуйте ещё раз.';
    if (err.code === 'not-configured') return 'Вход пока не подключён к серверу. Сообщите разработчику сайта.';
    if (err.code === 'bad-photo') return err.message;
    if (err.code === 'bad-code') return 'Неверный код.';
    if (err.code === 'too-many') return 'Слишком много попыток. Подождите 15 минут и попробуйте снова.';
    if (err.code === 'unauthorized') return 'Сессия закончилась. Войдите снова.';
    if (err.code === 'conflict') return 'Меню уже изменили в другом месте. Обновите страницу и повторите правки.';
    if (err.code === 'github') return 'Не удалось связаться с GitHub. Попробуйте ещё раз через минуту.';
    return 'Не удалось выполнить действие (' + (err.status || err.message) + '). Попробуйте ещё раз.';
  }

  function badPhoto(text) { const e = new Error(text); e.code = 'bad-photo'; return e; }

  // ---------- кодирование ----------
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = () => reject(new Error('read'));
      r.readAsDataURL(blob);
    });
  }

  // Уменьшает фото и пересохраняет в JPEG: быстрее грузится и пропадают метаданные (геолокация и т.п.)
  async function compressImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      try { await img.decode(); } catch (e) { throw badPhoto('Не удалось прочитать фото. Выберите другое (JPG или PNG).'); }
      const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const hh = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = hh;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, hh);
      ctx.drawImage(img, 0, 0, w, hh);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.82));
      if (!blob) throw badPhoto('Не удалось обработать фото. Выберите другое.');
      return blob;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function photoProblem(file) {
    if (!file) return 'Файл не выбран.';
    if (!/^image\//.test(file.type)) return 'Выберите картинку (JPG или PNG).';
    if (file.size > MAX_PHOTO_BYTES) return 'Фото слишком большое (больше 30 МБ).';
    return null;
  }

  // ---------- сообщения и состояние ----------
  function showMsg(el, text, kind) {
    el.textContent = text;
    el.className = 'msg' + (kind ? ' msg--' + kind : '');
    el.hidden = !text;
  }

  function updateBar() {
    $('saveBar').hidden = !(dirty || saving);
    $('saveBtn').disabled = saving;
    $('saveBtn').textContent = saving ? 'Сохраняю…' : 'Сохранить на сайте';
    if (!saving) $('saveInfo').textContent = 'Есть несохранённые изменения';
  }

  function markDirty() { dirty = true; updateBar(); }

  window.addEventListener('beforeunload', e => {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------- вход ----------
  function showApp() {
    $('loginView').hidden = true;
    $('appView').hidden = false;
    $('logoutBtn').hidden = false;
    render();
  }

  function showLogin(message) {
    $('appView').hidden = true;
    $('logoutBtn').hidden = true;
    $('loginView').hidden = false;
    $('saveBar').hidden = true;
    showMsg($('loginMsg'), message || '', message ? 'err' : '');
  }

  async function loadMenu() {
    const data = await api('/menu');
    csvSha = data.sha;
    dishes = MenuLib.parseMenu(data.csv).map(d =>
      Object.assign({}, d, { id: ++uid, file: null, previewUrl: null, isNew: false }));
    dirty = false;
  }

  $('showCode').addEventListener('change', e => { $('codeInput').type = e.target.checked ? 'text' : 'password'; });

  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const code = $('codeInput').value.trim();
    if (!code) { showMsg($('loginMsg'), 'Введите код.', 'err'); return; }
    $('loginBtn').disabled = true;
    $('loginBtn').textContent = 'Проверяю…';
    showMsg($('loginMsg'), '', '');
    try {
      const r = await api('/login', { method: 'POST', body: JSON.stringify({ code }) });
      session = r.session;
      if (!(dirty && dishes.length)) await loadMenu(); // после истёкшей сессии не затираем несохранённые правки
      if ($('rememberInput').checked) store.set(session); else store.clear();
      $('codeInput').value = '';
      showApp();
    } catch (err) {
      session = null;
      showMsg($('loginMsg'), explain(err), 'err');
    } finally {
      $('loginBtn').disabled = false;
      $('loginBtn').textContent = 'Войти';
    }
  });

  $('logoutBtn').addEventListener('click', () => {
    if (dirty && !confirm('Есть несохранённые изменения. Выйти без сохранения?')) return;
    store.clear();
    session = null; dishes = []; dirty = false;
    updateBar();
    showLogin('');
  });

  // ---------- список блюд ----------
  function emptyThumb() { return h('div', { class: 'dish-thumb dish-thumb--empty', text: 'нет фото' }); }

  function thumbFor(d) {
    const src = d.previewUrl || MenuLib.photoSrc(d.photo);
    if (!src) return emptyThumb();
    return h('img', {
      class: 'dish-thumb', src, alt: '',
      onerror: ev => ev.target.replaceWith(emptyThumb())
    });
  }

  function pickPhoto(d, file) {
    const problem = photoProblem(file);
    if (problem) { showMsg($('globalMsg'), problem, 'err'); return; }
    if (d.previewUrl) URL.revokeObjectURL(d.previewUrl);
    d.file = file;
    d.previewUrl = URL.createObjectURL(file);
    showMsg($('globalMsg'), '', '');
    markDirty();
    render();
  }

  function row(d) {
    const fileInput = h('input', { type: 'file', accept: 'image/*', onchange: ev => { pickPhoto(d, ev.target.files[0]); ev.target.value = ''; } });
    const tools = [
      h('label', { class: 'tool' }, document.createTextNode(d.photo || d.previewUrl ? 'Заменить фото' : 'Добавить фото'), fileInput)
    ];
    if (d.photo || d.previewUrl) {
      tools.push(h('button', {
        type: 'button', class: 'tool', text: 'Убрать фото',
        onclick: () => {
          if (d.previewUrl) URL.revokeObjectURL(d.previewUrl);
          d.photo = ''; d.file = null; d.previewUrl = null;
          markDirty(); render();
        }
      }));
    }
    tools.push(h('button', {
      type: 'button', class: 'tool tool--danger', text: 'Удалить',
      onclick: () => {
        if (!confirm('Удалить «' + d.name + '» из меню?')) return;
        dishes = dishes.filter(x => x !== d);
        markDirty(); render();
      }
    }));

    const shown = h('input', {
      type: 'checkbox',
      onchange: ev => { d.hidden = !ev.target.checked; markDirty(); render(); }
    });
    shown.checked = !d.hidden;

    return h('div', { class: 'dish-row' + (d.hidden ? ' is-hidden' : '') + (d.isNew ? ' is-new' : '') },
      thumbFor(d),
      h('div', { class: 'dish-fields' },
        h('input', {
          type: 'text', class: 'name', value: d.name, maxlength: 120, 'aria-label': 'Название блюда',
          oninput: ev => { d.name = ev.target.value; markDirty(); }
        }),
        h('div', { class: 'dish-line' },
          h('input', {
            type: 'text', class: 'price', value: d.price, maxlength: 40, inputmode: 'decimal',
            placeholder: 'Цена', 'aria-label': 'Цена',
            oninput: ev => { d.price = ev.target.value; markDirty(); }
          }),
          h('label', { class: 'check', style: 'margin:0' }, shown, h('span', { text: 'Показывать на сайте' }))
        ),
        h('div', { class: 'dish-tools' }, tools)
      )
    );
  }

  function render() {
    const list = $('dishList');
    list.textContent = '';
    const groups = new Map();
    dishes.forEach(d => {
      if (!groups.has(d.category)) groups.set(d.category, []);
      groups.get(d.category).push(d);
    });
    groups.forEach((items, cat) => {
      list.appendChild(h('h2', { class: 'cat', text: cat }));
      items.forEach(d => list.appendChild(row(d)));
    });
    if (!dishes.length) list.appendChild(h('p', { class: 'muted', text: 'В меню пока нет блюд. Нажмите «Добавить блюдо».' }));
    updateBar();
  }

  // ---------- добавление блюда ----------
  function fillCategories() {
    const sel = $('addCategory');
    sel.textContent = '';
    Array.from(new Set(dishes.map(d => d.category))).forEach(c => sel.appendChild(h('option', { value: c, text: c })));
    sel.appendChild(h('option', { value: '__new__', text: '＋ Новый раздел…' }));
    syncNewCategory();
  }

  function syncNewCategory() { $('addNewCatWrap').hidden = $('addCategory').value !== '__new__'; }
  $('addCategory').addEventListener('change', syncNewCategory);

  function resetAddForm() {
    $('addForm').reset();
    if (addPreviewUrl) URL.revokeObjectURL(addPreviewUrl);
    addFile = null; addPreviewUrl = null;
    $('addPreview').hidden = true;
    showMsg($('addMsg'), '', '');
    $('addForm').hidden = true;
  }

  $('addToggle').addEventListener('click', () => {
    const form = $('addForm');
    if (form.hidden) { fillCategories(); form.hidden = false; $('addName').focus(); }
    else resetAddForm();
  });
  $('addCancel').addEventListener('click', resetAddForm);

  $('addPhoto').addEventListener('change', ev => {
    const file = ev.target.files[0];
    if (!file) return;
    const problem = photoProblem(file);
    if (problem) { showMsg($('addMsg'), problem, 'err'); ev.target.value = ''; return; }
    if (addPreviewUrl) URL.revokeObjectURL(addPreviewUrl);
    addFile = file;
    addPreviewUrl = URL.createObjectURL(file);
    $('addPreview').src = addPreviewUrl;
    $('addPreview').hidden = false;
    showMsg($('addMsg'), '', '');
  });

  $('addForm').addEventListener('submit', ev => {
    ev.preventDefault();
    const category = ($('addCategory').value === '__new__' ? $('addNewCat').value : $('addCategory').value).trim();
    const name = $('addName').value.trim();
    if (!category) { showMsg($('addMsg'), 'Укажите раздел меню.', 'err'); return; }
    if (!name) { showMsg($('addMsg'), 'Укажите название блюда.', 'err'); return; }
    const d = {
      category, name, price: $('addPrice').value.trim(), photo: '', hidden: false,
      id: ++uid, file: addFile, previewUrl: addPreviewUrl, isNew: true
    };
    let last = -1;
    dishes.forEach((x, i) => { if (x.category === category) last = i; });
    if (last < 0) dishes.push(d); else dishes.splice(last + 1, 0, d);
    addFile = null; addPreviewUrl = null; // фото и превью теперь принадлежат блюду
    resetAddForm();
    markDirty();
    render();
  });

  // ---------- сохранение ----------
  async function save() {
    if (saving) return;
    if (dishes.some(d => !d.name.trim())) {
      showMsg($('globalMsg'), 'У одного из блюд пустое название — заполните или удалите его.', 'err');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    dishes.forEach(d => { d.name = d.name.trim(); d.price = d.price.trim(); });
    saving = true;
    showMsg($('globalMsg'), '', '');
    updateBar();
    try {
      const withPhotos = dishes.filter(d => d.file);
      let n = 0;
      for (const d of withPhotos) {
        n++;
        $('saveInfo').textContent = 'Загружаю фото ' + n + ' из ' + withPhotos.length + '…';
        const blob = await compressImage(d.file);
        const up = await api('/photo', { method: 'POST', body: JSON.stringify({ data: await blobToBase64(blob) }) });
        d.photo = up.path;
        d.file = null;
      }
      $('saveInfo').textContent = 'Сохраняю меню…';
      const res = await api('/menu', { method: 'PUT', body: JSON.stringify({ csv: MenuLib.toCSV(dishes), sha: csvSha }) });
      csvSha = res.sha;
      dishes.forEach(d => { d.isNew = false; });
      dirty = false;
      showMsg($('globalMsg'), 'Готово! Изменения появятся на сайте через 1–2 минуты.', 'ok');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      if (err.code === 'unauthorized') {
        // Сессия закончилась: правки остаются на экране, но нужно войти заново
        store.clear();
        session = null;
        saving = false;
        showLogin(explain(err));
        return;
      }
      showMsg($('globalMsg'), explain(err), 'err');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      saving = false;
      render();
    }
  }
  $('saveBtn').addEventListener('click', save);

  // ---------- автоматический вход, если сессия уже сохранена на этом устройстве ----------
  const saved = store.get();
  if (saved) {
    $('loginView').hidden = true;
    session = saved;
    loadMenu().then(showApp).catch(err => {
      if (err.code === 'unauthorized') store.clear();
      session = null;
      showLogin(explain(err));
    });
  }
})();
