// Общий код для сайта и панели владельца: чтение/запись data/menu.csv
(function (global) {
  const HEADER = ['Категория', 'Название', 'Цена', 'Фото', 'Показывать'];
  const HIDE_VALUES = ['нет', 'no', '0', 'false', 'скрыть', 'выкл', '-'];

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

  // Возвращает ВСЕ блюда, включая скрытые (hidden: true)
  function parseMenu(text) {
    const rows = parseCSV(text);
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
        hidden: HIDE_VALUES.includes(cell(r, iShow).toLowerCase())
      }))
      .filter(d => d.category && d.name);
  }

  function csvField(v) {
    v = String(v == null ? '' : v).replace(/\r?\n/g, ' ').trim();
    return /[",]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  function toCSV(dishes) {
    const lines = [HEADER.join(',')];
    dishes.forEach(d => {
      lines.push([d.category, d.name, d.price, d.photo, d.hidden ? 'нет' : ''].map(csvField).join(','));
    });
    return lines.join('\n') + '\n';
  }

  function formatPrice(raw) {
    const m = String(raw).replace(/ /g, ' ').match(/^\s*(\d[\d\s]*(?:[.,]\d+)?)\s*(?:₽|р\.?|руб\.?)?\s*$/i);
    if (!m) return raw;
    const n = parseFloat(m[1].replace(/\s/g, '').replace(',', '.'));
    return n.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ₽';
  }

  // Допустимы только файлы из папки сайта или https-ссылки; всё остальное отбрасывается
  function photoSrc(p) {
    if (!p) return null;
    if (/^https:\/\/[^\s"'<>]+$/i.test(p)) return p;
    if (/^[\w.\-\/]+\.(jpe?g|png|webp|avif)$/i.test(p) && !p.includes('..') && !p.startsWith('/')) {
      return p.includes('/') ? p : 'assets/img/' + p;
    }
    return null;
  }

  global.MenuLib = { parseCSV, parseMenu, toCSV, formatPrice, photoSrc };
})(window);
