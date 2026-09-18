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

// Menu tabs
const tabs = document.querySelectorAll('.menu__tab');
const panels = document.querySelectorAll('.menu__panel');
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('is-active'));
    panels.forEach(p => p.classList.remove('is-active'));
    tab.classList.add('is-active');
    document.querySelector(`.menu__panel[data-cat="${tab.dataset.cat}"]`).classList.add('is-active');
  });
});

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
