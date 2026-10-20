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

// ===== Menu (data-driven from data/menu.csv, edited via admin.html) =====
const MENU_CSV = 'data/menu.csv';
const PHOTO_FOCUS = {
  'dish-telyatina.jpg': '60% 78%',
  'gallery-02.jpg': '50% 55%',
  'gallery-21.jpg': '50% 55%',
  'gallery-09.jpg': '50% 60%',
  'dish-shashlik.jpg': '50% 45%',
  'dish-cheesecake.jpg': '50% 45%'
};

function dishCard(d) {
  const card = document.createElement('div');
  card.className = 'dish';
  const src = MenuLib.photoSrc(d.photo);
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
    price.textContent = MenuLib.formatPrice(d.price);
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
  let dishes = [];
  try {
    dishes = MenuLib.parseMenu(await fetchText(MENU_CSV, 8000)).filter(d => !d.hidden);
  } catch (err) {
    console.error('Не удалось загрузить меню', err);
  }
  if (dishes.length) {
    renderMenu(dishes);
  } else {
    const status = document.querySelector('#menuPanels .menu__status');
    if (status) status.textContent = 'Не удалось загрузить меню. Позвоните нам: +7 (969) 770-07-00';
  }
}

loadMenu();

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

// Owner panel window: nothing loads until the owner presses the small footer button
(function () {
  const modal = document.getElementById('ownerModal');
  const frame = document.getElementById('ownerFrame');
  const openBtn = document.getElementById('ownerOpen');
  const closeBtn = document.getElementById('ownerClose');
  if (!modal || !frame || !openBtn || !closeBtn) return;

  function open() {
    if (!frame.getAttribute('src')) frame.src = 'admin.html?embed=1';
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    closeBtn.focus();
  }
  function close() {
    modal.hidden = true;
    document.body.style.overflow = '';
    openBtn.focus();
  }

  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) close(); });
  window.addEventListener('message', e => {
    if (e.origin === location.origin && e.data && e.data.type === 'ribay-owner-close' && !modal.hidden) close();
  });
})();

// Вход по личной ссылке: https://сайт/#owner=КОД — сохраняем код на устройстве, убираем его из адреса и открываем панель
(function () {
  const m = location.hash.match(/^#owner=([A-Za-z0-9_]{20,255})$/);
  if (!m) return;
  try { localStorage.setItem('ribay_admin_token', m[1]); } catch (e) { /* приватный режим */ }
  history.replaceState(null, '', location.pathname + location.search);
  const openBtn = document.getElementById('ownerOpen');
  if (openBtn) openBtn.click();
})();
