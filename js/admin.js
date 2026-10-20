// Панель владельца: правит data/menu.csv и загружает фото прямо в репозиторий сайта через GitHub API.
// Код доступа хранится только в браузере владельца (localStorage) и отправляется только на api.github.com.
(() => {
  'use strict';

  const REPO = { owner: 'mogger112', name: 'ribay-steak-house', branch: 'main' };
  const R = REPO.owner + '/' + REPO.name;
  const CSV_PATH = 'data/menu.csv';
  const UPLOAD_DIR = 'assets/img/uploads';
  const TOKEN_KEY = 'ribay_admin_token';
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
    get() { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem(TOKEN_KEY, v); } catch (e) { /* приватный режим */ } },
    clear() { try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ничего */ } }
  };

  // Вход по личной ссылке вида .../admin.html#owner=КОД — код сохраняется на устройстве и сразу убирается из адреса
  (function () {
    const m = location.hash.match(/^#owner=([A-Za-z0-9_]{20,255})$/);
    if (!m) return;
    store.set(m[1]);
    history.replaceState(null, '', location.pathname + location.search);
  })();

  let token = null, csvSha = null, dishes = [], uid = 0, dirty = false, saving = false;
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

  // ---------- GitHub API ----------
  async function gh(path, options) {
    options = options || {};
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (options.body) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch('https://api.github.com' + path, Object.assign({}, options, { headers, cache: 'no-store' }));
    } catch (e) {
      const err = new Error('network'); err.code = 'network'; throw err;
    }
    if (!res.ok) { const err = new Error('HTTP ' + res.status); err.status = res.status; throw err; }
    return res.json();
  }

  function explain(err) {
    if (err.code === 'network') return 'Нет связи с интернетом или с GitHub. Проверьте подключение и попробуйте ещё раз.';
    if (err.code === 'no-push') return 'У этого кода нет права записи. При создании кода нужно выбрать Contents: Read and write.';
    if (err.code === 'bad-photo') return err.message;
    if (err.status === 401) return 'Код доступа неверный или срок его действия истёк.';
    if (err.status === 403 || err.status === 404) return 'Нет доступа к сайту. Проверьте, что код выдан на репозиторий ribay-steak-house и имеет право Contents: Read and write.';
    if (err.status === 409 || err.status === 422) return 'Меню уже изменили в другом месте. Обновите страницу и повторите правки.';
    return 'Не удалось выполнить действие (' + (err.status || err.message) + '). Попробуйте ещё раз.';
  }

  function badPhoto(text) { const e = new Error(text); e.code = 'bad-photo'; return e; }

  // ---------- кодирование ----------
  function decodeBase64(b64) {
    const bin = atob(b64.replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

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

  async function enter(t, remember) {
    token = t;
    const repo = await gh('/repos/' + R);
    if (repo.permissions && repo.permissions.push === false) {
      const e = new Error('no-push'); e.code = 'no-push'; throw e;
    }
    const file = await gh('/repos/' + R + '/contents/' + CSV_PATH + '?ref=' + REPO.branch);
    csvSha = file.sha;
    dishes = MenuLib.parseMenu(decodeBase64(file.content)).map(d =>
      Object.assign({}, d, { id: ++uid, file: null, previewUrl: null, isNew: false }));
    dirty = false;
    if (remember) store.set(t); else store.clear();
    showApp();
  }

  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const t = $('tokenInput').value.trim();
    if (!/^[A-Za-z0-9_]{20,255}$/.test(t)) {
      showMsg($('loginMsg'), 'Код выглядит неверно. Скопируйте его целиком, без пробелов.', 'err');
      return;
    }
    $('loginBtn').disabled = true;
    $('loginBtn').textContent = 'Проверяю…';
    showMsg($('loginMsg'), '', '');
    try {
      await enter(t, $('rememberInput').checked);
      $('tokenInput').value = '';
    } catch (err) {
      token = null;
      showMsg($('loginMsg'), explain(err), 'err');
    } finally {
      $('loginBtn').disabled = false;
      $('loginBtn').textContent = 'Войти';
    }
  });

  $('logoutBtn').addEventListener('click', () => {
    if (dirty && !confirm('Есть несохранённые изменения. Выйти без сохранения?')) return;
    store.clear();
    token = null; dishes = []; dirty = false;
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
        const fname = 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '.jpg';
        await gh('/repos/' + R + '/contents/' + UPLOAD_DIR + '/' + fname, {
          method: 'PUT',
          body: JSON.stringify({ message: 'Панель владельца: фото блюда', content: await blobToBase64(blob), branch: REPO.branch })
        });
        d.photo = UPLOAD_DIR + '/' + fname;
        d.file = null;
      }
      $('saveInfo').textContent = 'Сохраняю меню…';
      const text = MenuLib.toCSV(dishes);
      const res = await gh('/repos/' + R + '/contents/' + CSV_PATH, {
        method: 'PUT',
        body: JSON.stringify({
          message: 'Панель владельца: обновление меню',
          content: await blobToBase64(new Blob([text], { type: 'text/plain;charset=utf-8' })),
          sha: csvSha,
          branch: REPO.branch
        })
      });
      csvSha = res.content.sha;
      dishes.forEach(d => { d.isNew = false; });
      dirty = false;
      showMsg($('globalMsg'), 'Готово! Изменения появятся на сайте через 1–2 минуты.', 'ok');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      showMsg($('globalMsg'), explain(err), 'err');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      saving = false;
      render();
    }
  }
  $('saveBtn').addEventListener('click', save);

  // ---------- автоматический вход, если код уже сохранён на этом устройстве ----------
  const saved = store.get();
  if (saved) {
    $('loginView').hidden = true;
    enter(saved, true).catch(err => {
      if (err.status === 401) store.clear();
      token = null;
      showLogin(explain(err));
    });
  }
})();
