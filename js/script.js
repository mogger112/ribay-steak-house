document.getElementById('year').textContent = new Date().getFullYear();

// Mobile nav toggle
const burger = document.getElementById('burger');
const nav = document.getElementById('nav');
burger.addEventListener('click', () => {
  nav.classList.toggle('is-open');
});
nav.querySelectorAll('a').forEach(a => a.addEventListener('click', () => nav.classList.remove('is-open')));

// Header shadow on scroll
const header = document.getElementById('header');
window.addEventListener('scroll', () => {
  header.style.boxShadow = window.scrollY > 10 ? '0 10px 30px rgba(0,0,0,.35)' : 'none';
});

// ===== Menu (data-driven: Google Sheet CSV, fallback data/menu.csv) =====
const MENU_FALLBACK_CSV = 'data/menu.csv';
const HIDE_VALUES = ['нет', 'no', '0', 'false', 'скрыть', 'выкл', '-'];
const PHOTO_FOCUS = {
  'dish-telyatina.jpg': '60% 78%',
  'gallery-02.jpg': '50% 55%',
  'gallery-21.jpg': '50% 55%',
  'gallery-09.jpg': '50% 60%',
  'dish-shashlik.jpg': '50% 45%',
  'dish-cheesecake.jpg': '50% 45%'
};

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function rowsToDishes(rows) {
  if (!rows.length) return [];
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = names => head.findIndex(h => names.includes(h));
  const iCat = col(['категория', 'category']);
  const iName = col(['название', 'name']);
  const iPrice = col(['цена', 'price']);
  const iPhoto = col(['фото', 'photo']);
  const iShow = col(['показывать', 'show']);
  if (iCat < 0 || iName < 0) return [];
  const cell = (r, i) => (i >= 0 && r[i] ? r[i].trim() : '');
  return rows.slice(1)
    .map(r => ({
      category: cell(r, iCat),
      name: cell(r, iName),
      price: cell(r, iPrice),
      photo: cell(r, iPhoto),
      show: cell(r, iShow).toLowerCase()
    }))
    .filter(d => d.category && d.name && !HIDE_VALUES.includes(d.show));
}

function formatPrice(raw) {
  const m = raw.replace(/ /g, ' ').match(/^\s*(\d[\d\s]*(?:[.,]\d+)?)\s*(?:₽|р\.?|руб\.?)?\s*$/i);
  if (!m) return raw;
  const n = parseFloat(m[1].replace(/\s/g, '').replace(',', '.'));
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ₽';
}

function photoSrc(p) {
  if (!p) return null;
  if (/^https:\/\/[^\s"'<>]+$/i.test(p)) return p;
  if (/^[\w.\-\/]+\.(jpe?g|png|webp|avif)$/i.test(p) && !p.includes('..') && !p.startsWith('/')) {
    return p.includes('/') ? p : 'assets/img/' + p;
  }
  return null;
}

function dishCard(d) {
  const card = document.createElement('div');
  card.className = 'dish';
  const src = photoSrc(d.photo);
  if (src) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = d.name;
    img.loading = 'lazy';
    img.style.objectPosition = PHOTO_FOCUS[src.split('/').pop()] || '50% 50%';
    img.addEventListener('error', () => { img.remove(); card.classList.add('dish--noimg'); });
    card.appendChild(img);
  } else {
    card.classList.add('dish--noimg');
  }
  const body = document.createElement('div');
  body.className = 'dish__body';
  const h3 = document.createElement('h3');
  h3.textContent = d.name;
  body.appendChild(h3);
  if (d.price) {
    const price = document.createElement('span');
    price.className = 'price';
    price.textContent = formatPrice(d.price);
    body.appendChild(price);
  }
  card.appendChild(body);
  return card;
}

function renderMenu(dishes) {
  const tabsEl = document.getElementById('menuTabs');
  const panelsEl = document.getElementById('menuPanels');
  tabsEl.textContent = '';
  panelsEl.textContent = '';
  const groups = new Map();
  dishes.forEach(d => {
    if (!groups.has(d.category)) groups.set(d.category, []);
    groups.get(d.category).push(d);
  });
  let i = 0;
  groups.forEach((items, cat) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'menu__tab' + (i === 0 ? ' is-active' : '');
    tab.textContent = cat;
    tabsEl.appendChild(tab);
    const panel = document.createElement('div');
    panel.className = 'menu__panel' + (i === 0 ? ' is-active' : '');
    const grid = document.createElement('div');
    grid.className = 'menu__grid';
    items.forEach(d => grid.appendChild(dishCard(d)));
    panel.appendChild(grid);
    panelsEl.appendChild(panel);
    i++;
  });
}

document.getElementById('menuTabs').addEventListener('click', e => {
  const tab = e.target.closest('.menu__tab');
  if (!tab) return;
  const tabs = Array.from(document.querySelectorAll('#menuTabs .menu__tab'));
  const panels = document.querySelectorAll('#menuPanels .menu__panel');
  const idx = tabs.indexOf(tab);
  tabs.forEach((t, n) => t.classList.toggle('is-active', n === idx));
  panels.forEach((p, n) => p.classList.toggle('is-active', n === idx));
});

async function fetchText(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function loadMenu() {
  const sheetUrl = (window.RIBAY_CONFIG || {}).menuSheetCsvUrl;
  let dishes = [];
  if (sheetUrl) {
    try {
      dishes = rowsToDishes(parseCSV(await fetchText(sheetUrl, 6000)));
      if (!dishes.length) console.warn('Таблица меню пуста или опубликована неверно — показано резервное меню');
    } catch (err) {
      console.warn('Не удалось загрузить таблицу меню — показано резервное меню', err);
    }
  }
  if (!dishes.length) {
    try {
      dishes = rowsToDishes(parseCSV(await fetchText(MENU_FALLBACK_CSV, 8000)));
    } catch (err) {
      console.error('Не удалось загрузить меню', err);
    }
  }
  if (dishes.length) {
    renderMenu(dishes);
  } else {
    const status = document.querySelector('#menuPanels .menu__status');
    if (status) status.textContent = 'Не удалось загрузить меню. Позвоните нам: +7 (969) 770-07-00';
  }
}

loadMenu();

// Owner login link (opens the Google Sheet; access is controlled by Google account sharing)
(function () {
  const url = (window.RIBAY_CONFIG || {}).ownerEditUrl;
  const link = document.getElementById('ownerLink');
  if (link && url && /^https:\/\/docs\.google\.com\/spreadsheets\//.test(url)) {
    link.href = url;
    link.hidden = false;
  }
})();

// Lightbox for gallery
const galleryImgs = document.querySelectorAll('#galleryGrid img');
const lightbox = document.createElement('div');
lightbox.className = 'lightbox';
lightbox.innerHTML = '<button class="lightbox__close" aria-label="Закрыть">&times;</button><img alt="">';
document.body.appendChild(lightbox);
const lightboxImg = lightbox.querySelector('img');

galleryImgs.forEach(img => {
  img.addEventListener('click', () => {
    lightboxImg.src = img.src;
    lightboxImg.alt = img.alt;
    lightbox.classList.add('is-open');
  });
});
lightbox.addEventListener('click', (e) => {
  if (e.target !== lightboxImg) lightbox.classList.remove('is-open');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') lightbox.classList.remove('is-open');
});
