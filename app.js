/* 사진 보정 피드백 서비스 (photo-feedback)
 * - photos.js 가 window.PHOTOS 를 제공한다 (tools/build_assets.py 가 생성). labels 로 화면 라벨을 바꿀 수 있다.
 * - 좌표계: "캔버스" = 보정 전 사진을 0~1 로 정규화한 공간. 보정본은 크롭된 경우
 *   photos.js 의 align 사각형(캔버스 기준)에 맞춰 그 안에 배치된다. 피드백 핀 좌표도 캔버스 기준이다.
 * - 피드백은 localStorage(STORE_KEY) 에 저장되며 JSON 내보내기/가져오기를 지원한다.
 */
(() => {
'use strict';

const STORE_KEY = 'wedding-photo-feedback:v1';
const MAX_ZOOM = 8;
const PHOTOS = (window.PHOTOS && window.PHOTOS.photos) || [];
const LABELS = Object.assign({ before: '보정 전', after: '보정본' }, window.PHOTOS && window.PHOTOS.labels);
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

/* ---------------- 저장소 ---------------- */
/* 저장 방식
 *  - server : serve.py 로 띄운 경우. data/feedback.json 에 자동 저장 (SMB/Synology Drive 로 공유됨). 진실의 원본.
 *  - local  : index.html 을 file:// 로 직접 연 경우. data/feedback.js(있으면)를 바탕으로 localStorage 에만 저장.
 *             다른 PC 로 옮기려면 "내보내기"한 JSON 을 data/feedback.json 으로 넣거나 서버 모드에서 "가져오기".
 */
const store = {
  data: { version: 1, photos: {} },
  mode: 'local', saveTimer: null, status: '',
  load() {
    let local = null;
    try { const raw = localStorage.getItem(STORE_KEY); if (raw) local = JSON.parse(raw); } catch (e) { console.warn('저장소 읽기 실패', e); }
    const shared = window.FEEDBACK_DATA;
    // 공유 파일과 브라우저 사본 중 더 최근에 저장된 것을 사용
    if (shared && (!local || (shared.updated || '') >= (local.updated || ''))) this.data = shared;
    else if (local) this.data = local;
    if (!this.data.photos) this.data.photos = {};
  },
  async connect() {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') { this.setStatus('local'); return; }
    try {
      const r = await fetch('/api/feedback', { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      const server = await r.json();
      if (server && server.photos) {
        // 서버 파일이 비어 있고 브라우저에만 피드백이 있으면 (file:// 로 쓰다 전환한 경우) 서버로 올린다
        if (!Object.keys(server.photos).length && this.total()) await this.push();
        else this.data = server;
      }
      this.mode = 'server'; this.setStatus('server');
      renderGrid(); if (photo) { renderPins(); renderList(); }
    } catch (e) { this.setStatus('local'); }
  },
  save() {
    this.data.updated = new Date().toISOString();
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.data)); } catch (e) { console.warn(e); }
    if (this.mode === 'server') { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.push(), 300); }
    renderStats();
  },
  async push() {
    try {
      this.setStatus('saving');
      const r = await fetch('/api/feedback', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.data) });
      if (!r.ok) throw new Error((await r.json()).error || r.status);
      this.setStatus('server');
    } catch (e) { this.setStatus('error', e.message); }
  },
  setStatus(s, msg) {
    this.status = s;
    const el = $('#save-status');
    const text = { server: '파일에 자동 저장 중 (data/feedback.json)', saving: '저장하는 중…',
      error: '파일 저장 실패: ' + (msg || '') + ' — serve.py 가 실행 중인지 확인', local: '이 브라우저에만 저장됨 — 다른 PC 와 공유하려면 serve.py 로 실행하세요' }[s];
    el.textContent = text; el.className = 'save-status ' + s;
    $('#btn-export').hidden = $('#btn-import').hidden = false;
  },
  list(name) { return this.data.photos[name] || []; },
  add(name, fb) { (this.data.photos[name] ||= []).push(fb); this.save(); },
  update(name, id, text) { const f = this.list(name).find(f => f.id === id); if (f) { f.text = text; f.updated = new Date().toISOString(); this.save(); } },
  remove(name, id) { this.data.photos[name] = this.list(name).filter(f => f.id !== id); if (!this.data.photos[name].length) delete this.data.photos[name]; this.save(); },
  total() { return Object.values(this.data.photos).reduce((n, a) => n + a.length, 0); },
};
store.load();

/* ---------------- 라우팅 (인덱스 / 비교) ---------------- */
let currentIdx = 0;
function showView(view) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'compare') { requestAnimationFrame(layout); }
}
function go(view, name) {
  if (view === 'compare') {
    const i = PHOTOS.findIndex(p => p.name === name);
    location.hash = '#compare/' + encodeURIComponent(PHOTOS[i >= 0 ? i : currentIdx].name);
  } else location.hash = '#index';
}
function route() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith('compare/')) {
    const i = PHOTOS.findIndex(p => p.name === h.slice(8));
    if (i >= 0) currentIdx = i;
    showView('compare');     // 먼저 보이게 해야 pane 크기를 잴 수 있다
    openPhoto(currentIdx);
  } else { showView('index'); renderGrid(); }
}
window.addEventListener('hashchange', route);
$$('.nav-btn').forEach(b => b.addEventListener('click', () => go(b.dataset.view)));

/* ---------------- 인덱스 그리드 ---------------- */
const grid = $('#grid');
function renderGrid() {
  const onlyFb = $('#filter-fb').checked, onlyCrop = $('#filter-crop').checked;
  grid.innerHTML = '';
  let shown = 0;
  PHOTOS.forEach((p, i) => {
    const n = store.list(p.name).length;
    if (onlyFb && !n) return; if (onlyCrop && !p.cropped) return;
    shown++;
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<div class="thumb"><img loading="lazy" src="img/thumb/${encodeURIComponent(p.name)}" alt="${p.name}"></div>
      <div class="meta"><span class="num">${i + 1}</span><span class="name">${p.name}</span>
      ${p.cropped ? `<span class="badge crop-badge" title="${LABELS.after}이(가) 크롭됨">크롭</span>` : ''}
      ${n ? `<span class="badge fb">${n}</span>` : ''}</div>`;
    card.addEventListener('click', () => go('compare', p.name));
    grid.appendChild(card);
  });
  $('#index-count').textContent = `${shown} / ${PHOTOS.length}장`;
  renderStats();
}
$('#filter-fb').addEventListener('change', renderGrid);
$('#filter-crop').addEventListener('change', renderGrid);
function renderStats() {
  const photosWithFb = Object.keys(store.data.photos).length;
  $('#nav-stats').innerHTML = `사진 ${PHOTOS.length}장<br>피드백 ${store.total()}건 · ${photosWithFb}장`;
}

/* ---------------- 비교 뷰어 ---------------- */
const viewer = $('#viewer');
const panes = $$('.pane', viewer);
const view = { z: 1, cx: .5, cy: .5 };          // 줌(1=맞춤), 캔버스 기준 중심점
let photo = null, canvasAspect = 1.5;              // 현재 사진, 캔버스 가로/세로비
let mode = 'side';

function openPhoto(i) {
  currentIdx = i; photo = PHOTOS[i];
  if (!photo) return;
  canvasAspect = photo.before.w / photo.before.h;
  $('#photo-name').textContent = photo.name;
  $('#photo-pos').textContent = `${i + 1} / ${PHOTOS.length}`;
  $('#crop-badge').hidden = !photo.cropped;
  const b = 'img/before/' + encodeURIComponent(photo.name), a = 'img/after/' + encodeURIComponent(photo.name);
  $$('.img-before', viewer).forEach(img => img.src = b);
  $$('.img-after', viewer).forEach(img => img.src = a);
  view.z = 1; view.cx = view.cy = .5;
  closePopover(); hideAddPopup();
  layout(); renderPins(); renderList(); syncZoomUI();
}

/* 각 pane 에서 캔버스를 contain 으로 맞춘 기준 크기 */
function fitSize(pane) {
  const W = pane.clientWidth, H = pane.clientHeight;
  let w = W, h = W / canvasAspect;
  if (h > H) { h = H; w = H * canvasAspect; }
  return { W, H, w, h };
}
function clampCenter() {
  // 사진이 pane 보다 작으면 가운데, 크면 가장자리가 pane 안쪽으로 들어오지 않게
  const vis = panes.find(p => p.offsetParent); if (!vis) return;
  const f = fitSize(vis);
  const sw = f.w * view.z, sh = f.h * view.z;
  const mx = Math.min(.5, f.W / (2 * sw)), my = Math.min(.5, f.H / (2 * sh));
  view.cx = sw <= f.W ? .5 : Math.min(1 - mx, Math.max(mx, view.cx));
  view.cy = sh <= f.H ? .5 : Math.min(1 - my, Math.max(my, view.cy));
}
function layout() {
  if (!photo) return;
  clampCenter();
  // 주의: 확대는 CSS scale() 이 아니라 stage/img 의 실제 크기를 키워서 한다.
  // scale(8) 변환을 쓰면 Chrome 이 pane 밖까지 포함한 8배 크기 레이어를 통째로 래스터라이즈해
  // 사진 한 장에 수백 MB 를 먹고, 여러 장 넘기면 탭이 죽는다. 크기를 키우면 overflow:hidden 으로
  // 잘린 보이는 타일만 그린다.
  panes.forEach(pane => {
    if (!pane.offsetParent) return;
    const f = fitSize(pane), sw = f.w * view.z, sh = f.h * view.z;
    const stage = $('.stage', pane);
    stage.style.width = sw + 'px'; stage.style.height = sh + 'px';
    const before = $('.img-before', stage), after = $('.img-after', stage);
    if (before) { before.style.width = sw + 'px'; before.style.height = sh + 'px'; before.style.left = before.style.top = 0; }
    if (after) {
      const al = photo.align || { x: 0, y: 0, w: 1, h: 1 };
      after.style.left = al.x * sw + 'px'; after.style.top = al.y * sh + 'px';
      after.style.width = al.w * sw + 'px'; after.style.height = al.h * sh + 'px';
    }
    const tx = f.W / 2 - view.cx * sw, ty = f.H / 2 - view.cy * sh;
    stage.style.transform = `translate(${Math.round(tx)}px, ${Math.round(ty)}px)`;
    $$('.pin', stage).forEach(pin => { pin.style.left = pin.dataset.x * sw + 'px'; pin.style.top = pin.dataset.y * sh + 'px'; });
  });
  updateAddPopupPos();
}
new ResizeObserver(() => layout()).observe(viewer);

/* pane 의 화면 좌표 → 캔버스 정규화 좌표 */
function toCanvas(pane, clientX, clientY) {
  const r = pane.getBoundingClientRect(), f = fitSize(pane);
  const tx = f.W / 2 - view.cx * f.w * view.z, ty = f.H / 2 - view.cy * f.h * view.z;
  return { u: (clientX - r.left - tx) / (f.w * view.z), v: (clientY - r.top - ty) / (f.h * view.z) };
}
function toScreen(pane, u, v) {
  const r = pane.getBoundingClientRect(), f = fitSize(pane);
  const tx = f.W / 2 - view.cx * f.w * view.z, ty = f.H / 2 - view.cy * f.h * view.z;
  return { x: r.left + tx + u * f.w * view.z, y: r.top + ty + v * f.h * view.z };
}

/* 줌: 지정한 화면 지점을 고정한 채 배율 변경 */
function zoomAt(pane, clientX, clientY, newZ) {
  newZ = Math.min(MAX_ZOOM, Math.max(1, newZ));
  const { u, v } = toCanvas(pane, clientX, clientY);
  const f = fitSize(pane), r = pane.getBoundingClientRect();
  view.z = newZ;
  const tx = (clientX - r.left) - u * f.w * newZ, ty = (clientY - r.top) - v * f.h * newZ;
  view.cx = (f.W / 2 - tx) / (f.w * newZ); view.cy = (f.H / 2 - ty) / (f.h * newZ);
  layout(); syncZoomUI();
}
function zoomCenter(newZ) {
  const pane = panes.find(p => p.offsetParent); if (!pane) return; const r = pane.getBoundingClientRect();
  zoomAt(pane, r.left + r.width / 2, r.top + r.height / 2, newZ);
}
const zoomSlider = $('#zoom');
const sliderToZ = v => Math.exp(Math.log(MAX_ZOOM) * v / 100);
const zToSlider = z => 100 * Math.log(z) / Math.log(MAX_ZOOM);
function syncZoomUI() { zoomSlider.value = zToSlider(view.z); $('#zoom-out').textContent = Math.round(view.z * 100) + '%'; }
zoomSlider.addEventListener('input', () => zoomCenter(sliderToZ(+zoomSlider.value)));
$('#btn-fit').addEventListener('click', () => { view.z = 1; view.cx = view.cy = .5; layout(); syncZoomUI(); });

/* 포인터 입력: 드래그 이동 / 클릭 → 피드백 추가 / 휠·핀치 줌 */
panes.forEach(pane => {
  let down = null, dragging = false;
  pane.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('.pin')) return;
    down = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy }; dragging = false;
    pane.setPointerCapture(e.pointerId);
  });
  pane.addEventListener('pointermove', e => {
    if (!down) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (!dragging && Math.hypot(dx, dy) > 4) { dragging = true; pane.classList.add('dragging'); hideAddPopup(); }
    if (dragging) {
      const f = fitSize(pane);
      view.cx = down.cx - dx / (f.w * view.z); view.cy = down.cy - dy / (f.h * view.z);
      layout();
    }
  });
  pane.addEventListener('pointerup', e => {
    if (!down) return;
    const wasDrag = dragging; down = null; dragging = false; pane.classList.remove('dragging');
    if (wasDrag) return;
    closePopover();
    const { u, v } = toCanvas(pane, e.clientX, e.clientY);
    if (u < 0 || u > 1 || v < 0 || v > 1) { hideAddPopup(); return; }
    showAddPopup(u, v, pane);
  });
  pane.addEventListener('pointercancel', () => { down = null; dragging = false; pane.classList.remove('dragging'); });

  pane.addEventListener('wheel', e => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {           // 트랙패드 핀치(브라우저가 ctrlKey 로 전달) 또는 Ctrl+휠
      const factor = Math.exp(-e.deltaY * 0.01);
      zoomAt(pane, e.clientX, e.clientY, view.z * factor);
    } else {                                 // 두 손가락 스크롤 → 이동
      const f = fitSize(pane);
      view.cx += e.deltaX / (f.w * view.z); view.cy += e.deltaY / (f.h * view.z);
      layout();
    }
    hideAddPopup();
  }, { passive: false });

  // Safari 의 핀치 제스처
  let gestureZ = 1;
  pane.addEventListener('gesturestart', e => { e.preventDefault(); gestureZ = view.z; });
  pane.addEventListener('gesturechange', e => { e.preventDefault(); zoomAt(pane, e.clientX, e.clientY, gestureZ * e.scale); });
  pane.addEventListener('gestureend', e => e.preventDefault());
});

/* ---------------- 모드 ---------------- */
$$('#mode-seg button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
function setMode(m) {
  mode = m;
  $$('#mode-seg button').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  viewer.classList.toggle('side', m === 'side'); viewer.classList.toggle('overlay', m === 'overlay');
  $('#overlay-ctl').hidden = m !== 'overlay';
  if (m !== 'overlay') stopBlink();
  hideAddPopup(); closePopover();
  requestAnimationFrame(() => { layout(); renderPins(); });
}
const opacity = $('#opacity');
const overlayAfter = $('.overlay-pane .img-after');
function applyOpacity() { overlayAfter.style.opacity = opacity.value / 100; $('#opacity-out').textContent = opacity.value + '%'; }
opacity.addEventListener('input', applyOpacity); applyOpacity();

let blinkTimer = null;
$('#btn-blink').addEventListener('click', () => blinkTimer ? stopBlink() : startBlink());
function startBlink() {
  $('#btn-blink').classList.add('active'); let on = true;
  blinkTimer = setInterval(() => { on = !on; overlayAfter.style.opacity = on ? 1 : 0; $('#overlay-hint').textContent = on ? `— ${LABELS.after}` : `— ${LABELS.before}`; }, 700);
}
function stopBlink() {
  clearInterval(blinkTimer); blinkTimer = null; $('#btn-blink').classList.remove('active');
  $('#overlay-hint').textContent = `— 아래: ${LABELS.before} / 위: ${LABELS.after}`; applyOpacity();
}
$('#btn-diff').addEventListener('click', e => { const on = viewer.classList.toggle('diff'); e.currentTarget.classList.toggle('active', on); if (on) stopBlink(); });

$('#btn-pins').addEventListener('click', e => {
  const hidden = viewer.classList.toggle('hide-pins');
  e.currentTarget.classList.toggle('active', !hidden);
  e.currentTarget.textContent = hidden ? '피드백 숨김' : '피드백 보이기';
  if (hidden) closePopover();
});

/* ---------------- 피드백 추가 팝업 ---------------- */
const addPopup = $('#add-popup');
let pending = null;   // {u, v, pane} 추가 대기 중인 좌표와 클릭한 pane
function showAddPopup(u, v, pane) {
  pending = { u, v, pane }; addPopup.hidden = false; renderPins(); updateAddPopupPos();
}
function hideAddPopup() { if (!pending) return; pending = null; addPopup.hidden = true; renderPins(); }
/* 현재 보이는 pane 중 기준으로 쓸 것: 클릭한 pane 이 보이면 그것, 아니면 첫 번째 보이는 pane */
function anchorPane(preferred) {
  if (preferred && preferred.offsetParent) return preferred;
  return panes.find(p => p.offsetParent) || panes[0];
}
function updateAddPopupPos() {
  if (!pending) return;
  const pane = anchorPane(pending.pane); if (!pane) return;
  const { x, y } = toScreen(pane, pending.u, pending.v);
  addPopup.style.left = x + 'px'; addPopup.style.top = y + 'px';
}
$('#btn-add-fb').addEventListener('click', () => {
  if (!pending) return;
  const fb = { id: 'fb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), x: pending.u, y: pending.v, text: '', created: new Date().toISOString() };
  const pos = { ...pending }; hideAddPopup();
  openPopover(fb, pos, true, pos.pane);   // 새 항목: 저장 시점에 store 에 추가
});

/* ---------------- 핀 ---------------- */
function renderPins() {
  if (!photo) return;
  const list = store.list(photo.name);
  $$('.pins', viewer).forEach(layer => {
    const pane = layer.closest('.pane'); if (!pane.offsetParent) { layer.innerHTML = ''; return; }
    const f = fitSize(pane), sw = f.w * view.z, sh = f.h * view.z;
    layer.innerHTML = '';
    list.forEach((fb, i) => {
      const pin = document.createElement('div');
      pin.className = 'pin' + (activeId === fb.id ? ' active' : ''); pin.textContent = i + 1; pin.dataset.id = fb.id;
      pin.dataset.x = fb.x; pin.dataset.y = fb.y;
      pin.style.left = fb.x * sw + 'px'; pin.style.top = fb.y * sh + 'px';
      pin.title = fb.text;
      pin.addEventListener('pointerdown', e => e.stopPropagation());
      pin.addEventListener('click', e => { e.stopPropagation(); hideAddPopup(); openPopover(fb, { u: fb.x, v: fb.y }, false, pane); });
      layer.appendChild(pin);
    });
    if (pending) {
      const t = document.createElement('div'); t.className = 'pin temp'; t.textContent = '+';
      t.dataset.x = pending.u; t.dataset.y = pending.v;
      t.style.left = pending.u * sw + 'px'; t.style.top = pending.v * sh + 'px';
      layer.appendChild(t);
    }
  });
}

/* ---------------- 팝오버 (보기/수정/삭제) ---------------- */
const pop = $('#fb-popover'), popText = $('#pop-text'), ta = $('#pop-textarea');
let popFb = null, popIsNew = false, activeId = null;
function openPopover(fb, pos, isNew, nearPane) {
  popFb = fb; popIsNew = isNew; activeId = isNew ? null : fb.id;
  const idx = store.list(photo.name).findIndex(f => f.id === fb.id);
  $('#pop-title').textContent = isNew ? '새 피드백' : `피드백 #${idx + 1}`;
  pop.hidden = false;
  setEditing(isNew || !fb.text);
  const pane = anchorPane(nearPane), { x, y } = toScreen(pane, pos.u, pos.v);
  const w = 320, h = pop.offsetHeight || 180;
  // 오른쪽에 자리가 없으면 핀의 왼쪽에 띄운다 (핀을 가리지 않도록)
  const left = x + 16 + w > window.innerWidth - 8 ? x - 16 - w : x + 16;
  pop.style.left = Math.max(8, left) + 'px';
  pop.style.top = Math.max(8, Math.min(window.innerHeight - h - 8, y - 20)) + 'px';
  renderPins(); renderList();
}
function setEditing(on) {
  $('#pop-view').hidden = on; $('#pop-edit-form').hidden = !on;
  if (on) { ta.value = popFb.text; setTimeout(() => ta.focus(), 0); }
  else popText.textContent = popFb.text;
}
function closePopover() {
  if (pop.hidden) return;
  pop.hidden = true; popFb = null; activeId = null; renderPins(); renderList();
}
function savePopover() {
  const text = ta.value.trim();
  if (!text) { ta.focus(); return; }
  if (popIsNew) { popFb.text = text; store.add(photo.name, popFb); popIsNew = false; activeId = popFb.id; }
  else store.update(photo.name, popFb.id, text);
  popFb.text = text; setEditing(false);
  $('#pop-title').textContent = `피드백 #${store.list(photo.name).findIndex(f => f.id === popFb.id) + 1}`;
  renderPins(); renderList();
}
function deleteFb(id) {
  if (!confirm('이 피드백을 삭제할까요?')) return;
  store.remove(photo.name, id);
  if (popFb && popFb.id === id) closePopover();
  renderPins(); renderList();
}
$('#pop-close').addEventListener('click', closePopover);
$('#pop-edit').addEventListener('click', () => setEditing(true));
$('#pop-delete').addEventListener('click', () => deleteFb(popFb.id));
$('#pop-save').addEventListener('click', savePopover);
$('#pop-cancel').addEventListener('click', () => popIsNew || !popFb.text ? closePopover() : setEditing(false));
ta.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); savePopover(); } });

/* ---------------- 하단 피드백 목록 ---------------- */
const fbList = $('#fb-list');
function renderList() {
  if (!photo) return;
  const list = store.list(photo.name);
  $('#fb-count').textContent = list.length ? `${list.length}건` : '';
  $('#fb-empty').hidden = list.length > 0;
  fbList.innerHTML = '';
  list.forEach((fb, i) => {
    const li = document.createElement('li');
    li.className = 'fb-item' + (activeId === fb.id ? ' active' : '');
    const when = new Date(fb.updated || fb.created).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
    li.innerHTML = `<span class="dot">${i + 1}</span><div class="txt"></div>
      <div class="acts"><button data-act="edit">수정</button><button data-act="del" class="danger">삭제</button></div>`;
    const txt = $('.txt', li); txt.textContent = fb.text;
    txt.insertAdjacentHTML('beforeend', `<small>${when}${fb.updated ? ' 수정' : ''}</small>`);
    li.addEventListener('click', e => {
      const act = e.target.dataset.act;
      if (act === 'del') { deleteFb(fb.id); return; }
      // 핀이 보이도록 중심 이동 후 팝오버 열기
      view.cx = fb.x; view.cy = fb.y; layout();
      openPopover(fb, { u: fb.x, v: fb.y }, false);
      if (act === 'edit') setEditing(true);
    });
    fbList.appendChild(li);
  });
}

/* ---------------- 이전/다음, 키보드 ---------------- */
function step(d) {
  // hashchange 가 처리되기 전에 키를 연타해도 건너뛰지 않도록 인덱스를 즉시 갱신
  currentIdx = (currentIdx + d + PHOTOS.length) % PHOTOS.length; go('compare', PHOTOS[currentIdx].name);
}
$('#btn-prev').addEventListener('click', () => step(-1));
$('#btn-next').addEventListener('click', () => step(1));
document.addEventListener('keydown', e => {
  if (e.target.matches('textarea, input')) { if (e.key === 'Escape') closePopover(); return; }
  if (!$('#view-compare').classList.contains('active')) return;
  if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
  else if (e.key === 'Escape') { closePopover(); hideAddPopup(); }
  else if (e.key === '0') { view.z = 1; view.cx = view.cy = .5; layout(); syncZoomUI(); }
  else if (e.key === '1') setMode('side');
  else if (e.key === '2') setMode('overlay');
});
document.addEventListener('pointerdown', e => {
  if (!e.target.closest('#fb-popover, .pin, #add-popup, .fb-item')) { if (!e.target.closest('.pane')) closePopover(); }
});
setTimeout(() => $('#hint').classList.add('fade'), 6000);

/* ---------------- 내보내기 / 가져오기 ---------------- */
$('#btn-export').addEventListener('click', () => {
  // 전달용: 보정본 기준 좌표(after.x/y, 크롭 반영)도 함께 기록
  const out = { exported: new Date().toISOString(), photos: [] };
  PHOTOS.forEach((p, i) => {
    const list = store.list(p.name); if (!list.length) return;
    const al = p.align || { x: 0, y: 0, w: 1, h: 1 };
    out.photos.push({ index: i + 1, name: p.name, cropped: !!p.cropped, feedback: list.map((f, j) => ({
      no: j + 1, text: f.text, created: f.created, updated: f.updated,
      before: { x: +f.x.toFixed(4), y: +f.y.toFixed(4) },
      after: { x: +((f.x - al.x) / al.w).toFixed(4), y: +((f.y - al.y) / al.h).toFixed(4) } })) });
  });
  const blob = new Blob([JSON.stringify({ ...out, raw: store.data }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `wedding-feedback-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
$('#btn-import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return; e.target.value = '';
  try {
    const json = JSON.parse(await file.text());
    const incoming = json.raw?.photos || json.photos;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new Error('이 서비스에서 내보낸 JSON 이 아닙니다');
    const n = Object.values(incoming).reduce((s, a) => s + a.length, 0);
    const replace = confirm(`${n}건의 피드백을 가져옵니다.\n\n확인 = 현재 피드백을 모두 교체\n취소 = 현재 피드백에 합치기`);
    if (replace) store.data.photos = incoming;
    else for (const [name, list] of Object.entries(incoming)) {
      const cur = store.data.photos[name] ||= [];
      list.forEach(f => { if (!cur.some(c => c.id === f.id)) cur.push(f); });
    }
    store.save(); renderGrid(); if (photo) { renderPins(); renderList(); }
  } catch (err) { alert('가져오기 실패: ' + err.message); }
});

/* ---------------- 시작 ---------------- */
$$('[data-label]').forEach(el => el.textContent = LABELS[el.dataset.label]);
$$('.img-before').forEach(i => i.alt = LABELS.before); $$('.img-after').forEach(i => i.alt = LABELS.after);
$('#overlay-hint').textContent = `— 아래: ${LABELS.before} / 위: ${LABELS.after}`;
if (!PHOTOS.length) {
  grid.innerHTML = '<p class="empty">photos.js 가 없습니다. 터미널에서 <code>python3 photo-feedback/tools/build_assets.py</code> 를 실행해 섬네일과 목록을 생성하세요.</p>';
}
renderStats();
route();
store.connect();
})();
