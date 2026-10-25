/* 업체 전달용 ZIP 내보내기 (photo-feedback)
 *
 * 전부 브라우저에서 처리한다 — 서버(NAS)에 이미지 라이브러리가 없어도 되도록.
 *   1. 사진 목록·피드백을 골라 (기본: 피드백 있는 사진만)
 *   2. 섬네일/프리뷰를 fetch 하고 (서버 모드에서만 가능 — file:// 에서는 fetch 불가)
 *   3. 보정본 위에 번호 핀 + 피드백마다 보정 전/보정본 비교 크롭 + 메모 패널을 Canvas 로 그려 feedback/<이름>.jpg 생성
 *   4. 읽기 전용 뷰어(index.html/style.css/app.js + photos.js(readonly) + data/feedback.js), readme, 피드백 목록.txt 를 넣어
 *   5. 자체 구현한 store(무압축) ZIP 으로 묶어 다운로드한다. (JPEG 는 압축 효과가 없어 store 로 충분)
 *
 * ZIP 구조 (최상위 폴더 없음 — Windows "압축 풀기" 가 zip 이름 폴더를 하나 더 만들기 때문):
 *   readme.html, readme.txt, 피드백 목록.txt, index.html, style.css, app.js, photos.js, data/feedback.js,
 *   img/thumb/*.jpg, before/*.jpg, after/*.jpg, feedback/*.jpg
 * 폴더 이름은 ASCII 고정 (한글 폴더명은 NFD/구형 압축도구 문제가 있어 피함). 한글 라벨은 readme/뷰어에서만 보여준다.
 *
 * 진입점: window.PhotoExport.run({ photos, feedback, labels, title, scope, onProgress }) → Promise<{blob, filename, stats}>
 */
(() => {
'use strict';

/* ---- 조절 가능한 상수 ---- */
const IMG_LONG_EDGE = 2000;      // feedback/ 이미지의 사진 부분 긴 변 px
const PIN_RADIUS_RATIO = 0.012;  // 핀 반지름 / 긴 변
const CROP_FRAC = 0.16;          // 비교 크롭이 덮는 범위 (보정 전 사진 너비 대비)
const CROP_PX_RATIO = 0.17;      // 크롭 썸네일 한 변 / 긴 변
const FONT_RATIO = 0.013;        // 메모 글자 크기 / 긴 변
const JPEG_QUALITY = 0.85;
const FETCH_CONCURRENCY = 3;     // NAS 가 느리므로 동시 요청 제한
const FETCH_RETRIES = 3;
const FETCH_TIMEOUT_MS = 60000;
const FONT_STACK = '"Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", "Noto Sans CJK KR", sans-serif';

const NFC = s => s.normalize ? s.normalize('NFC') : s;
const enc = new TextEncoder();

/* ================= ZIP writer (store only) ================= */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(u8, crc = 0) {
  crc = ~crc >>> 0;
  for (let i = 0; i < u8.length; i++) crc = CRC_TABLE[(crc ^ u8[i]) & 0xFF] ^ (crc >>> 8);
  return (~crc) >>> 0;
}
function dosDateTime(d) {
  const y = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}
function u16(v) { return [v & 0xFF, (v >>> 8) & 0xFF]; }
function u32(v) { return [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]; }

/** entries: [{name, data: Blob|string|Uint8Array}] → Blob (application/zip) */
async function buildZip(entries, onProgress) {
  const parts = [], central = [];
  let offset = 0;
  const now = dosDateTime(new Date());
  if (entries.length > 65000) throw new Error('ZIP 항목이 너무 많습니다 (zip64 미지원)');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const name = enc.encode(NFC(e.name));
    let payload = e.data, size, crc;
    if (typeof payload === 'string') payload = enc.encode(payload);
    if (payload instanceof Blob) {
      const buf = new Uint8Array(await payload.arrayBuffer());   // CRC 계산용으로 한 번만 읽고 버린다
      size = buf.length; crc = crc32(buf);
    } else { size = payload.length; crc = crc32(payload); }
    if (size >= 0xFFFFFFFF || offset + size >= 0xFFFFFFFF) throw new Error('4GB 를 넘는 ZIP 은 지원하지 않습니다');
    const flags = 0x0800;                                          // UTF-8 파일명
    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(flags), ...u16(0), ...u16(now.time), ...u16(now.date),
      ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0)]);
    parts.push(local, name, payload);
    central.push(new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(flags), ...u16(0), ...u16(now.time), ...u16(now.date),
      ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset)]), name);
    offset += local.length + name.length + size;
    if (onProgress && i % 10 === 0) onProgress(i, entries.length);
  }
  const cdStart = offset, cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length),
    ...u32(cdSize), ...u32(cdStart), ...u16(0)]);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

/* ================= fetch 도우미 ================= */
async function fetchWithRetry(url, as = 'blob') {
  let lastErr;
  for (let attempt = 0; attempt < FETCH_RETRIES; attempt++) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(url, { cache: 'no-store', signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return as === 'text' ? await r.text() : await r.blob();
    } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 500 * (attempt + 1))); }
    finally { clearTimeout(timer); }
  }
  throw new Error(`${url} 가져오기 실패: ${lastErr && lastErr.message}`);
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/* ================= 텍스트 줄바꿈 ================= */
function wrapText(ctx, text, maxW) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    const words = para.split(' ');
    for (let w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width <= maxW) { line = test; continue; }
      if (line) { lines.push(line); line = ''; }
      // 한 단어가 너비를 넘으면 글자 단위로
      for (const ch of w) {
        if (ctx.measureText(line + ch).width > maxW && line) { lines.push(line); line = ''; }
        line += ch;
      }
    }
    lines.push(line);
  }
  return lines;
}

/* ================= 주석 이미지 ================= */
async function renderAnnotated(photo, list, beforeBlob, afterBlob, labels) {
  const [bB, bA] = await Promise.all([createImageBitmap(beforeBlob), createImageBitmap(afterBlob)]);
  try {
    const al = photo.align || { x: 0, y: 0, w: 1, h: 1 };
    const long = Math.max(bA.width, bA.height), s = IMG_LONG_EDGE / long;
    const IW = Math.round(bA.width * s), IH = Math.round(bA.height * s);
    const L = IMG_LONG_EDGE, R = Math.round(L * PIN_RADIUS_RATIO), font = Math.round(L * FONT_RATIO), lh = Math.round(font * 1.45);
    const C = Math.round(L * CROP_PX_RATIO), pad = Math.round(L * 0.02), gap = Math.round(L * 0.012);
    const header = Math.round(font * 2.6);
    // 1-pass: 메모 줄 수 측정
    const m = document.createElement('canvas').getContext('2d');
    m.font = `${font}px ${FONT_STACK}`;
    const textW = IW - pad * 2 - C * 2 - gap * 2 - Math.round(font * 2.2);
    const rows = list.map(fb => {
      const ax = (fb.x - al.x) / al.w, ay = (fb.y - al.y) / al.h;
      const outside = ax < 0 || ax > 1 || ay < 0 || ay > 1;
      const lines = wrapText(m, fb.text + (outside ? `\n(${labels.after} 밖 영역 — ${labels.before} 크롭 참고)` : ''), textW);
      return { fb, ax, ay, outside, lines, h: Math.max(C, lines.length * lh) + gap };
    });
    const panelH = pad + rows.reduce((s, r) => s + r.h, 0) + pad;
    const cv = document.createElement('canvas'); cv.width = IW; cv.height = header + IH + panelH;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    // 헤더
    ctx.fillStyle = '#111'; ctx.font = `bold ${Math.round(font * 1.15)}px ${FONT_STACK}`; ctx.textBaseline = 'middle';
    ctx.fillText(`${photo.name}   —   피드백 ${list.length}건`, pad, header / 2);
    ctx.font = `${Math.round(font * 0.85)}px ${FONT_STACK}`; ctx.fillStyle = '#666'; ctx.textAlign = 'right';
    ctx.fillText(`${labels.after} 위에 표시 · 아래 패널: 번호별 ${labels.before}/${labels.after} 비교 크롭`, IW - pad, header / 2);
    ctx.textAlign = 'left';
    // 사진
    ctx.drawImage(bA, 0, header, IW, IH);
    const pin = (x, y, n, r) => {
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = '#ff3b30'; ctx.fill();
      ctx.lineWidth = Math.max(2, r * 0.18); ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(r * 1.1)}px ${FONT_STACK}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(n), x, y + r * 0.05); ctx.textAlign = 'left';
    };
    rows.forEach((r, i) => {
      // 크롭 밖 핀은 가장자리 안쪽으로 붙이고 반투명 처리 (패널의 보정 전 크롭으로 위치를 안내)
      const x = Math.min(IW - R, Math.max(R, r.ax * IW)), y = header + Math.min(IH - R, Math.max(R, r.ay * IH));
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = R * 0.6; if (r.outside) ctx.globalAlpha = 0.55;
      pin(x, y, i + 1, R); ctx.restore();
    });
    // 패널: 번호 | 보정 전 크롭 | 보정본 크롭 | 메모
    let y = header + IH + pad;
    const half = CROP_FRAC / 2;                               // 보정 전 너비 기준 반폭 (정사각형)
    const halfV = half * (bB.width / bB.height);
    rows.forEach((r, i) => {
      const fb = r.fb, numW = Math.round(font * 2.2);
      ctx.fillStyle = '#111'; ctx.font = `bold ${font}px ${FONT_STACK}`; ctx.textBaseline = 'top';
      pin(pad + numW / 2 - font * 0.3, y + C / 2, i + 1, Math.round(font * 0.75));
      // 보정 전 크롭 (캔버스 좌표 → 보정 전 px)
      const bx = pad + numW, ax0 = bx + C + gap;
      const sx = (fb.x - half) * bB.width, sy = (fb.y - halfV) * bB.height, sw = CROP_FRAC * bB.width, sh = 2 * halfV * bB.height;
      ctx.fillStyle = '#eee'; ctx.fillRect(bx, y, C, C); ctx.fillRect(ax0, y, C, C);
      ctx.save(); ctx.beginPath(); ctx.rect(bx, y, C, C); ctx.clip(); ctx.drawImage(bB, sx, sy, sw, sh, bx, y, C, C); ctx.restore();
      // 보정본 크롭 (같은 캔버스 영역 → 보정본 px)
      const asx = ((fb.x - half) - al.x) / al.w * bA.width, asy = ((fb.y - halfV) - al.y) / al.h * bA.height;
      const asw = CROP_FRAC / al.w * bA.width, ash = 2 * halfV / al.h * bA.height;
      ctx.save(); ctx.beginPath(); ctx.rect(ax0, y, C, C); ctx.clip(); ctx.drawImage(bA, asx, asy, asw, ash, ax0, y, C, C); ctx.restore();
      // 크롭 중앙 표시 + 라벨
      for (const cx of [bx + C / 2, ax0 + C / 2]) {
        ctx.beginPath(); ctx.arc(cx, y + C / 2, Math.round(C * 0.06), 0, Math.PI * 2); ctx.strokeStyle = '#ff3b30'; ctx.lineWidth = 3; ctx.stroke();
      }
      ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(bx, y + C - font * 1.3, C, font * 1.3); ctx.fillRect(ax0, y + C - font * 1.3, C, font * 1.3);
      ctx.fillStyle = '#fff'; ctx.font = `${Math.round(font * 0.8)}px ${FONT_STACK}`; ctx.textBaseline = 'middle';
      ctx.fillText(labels.before, bx + font * 0.4, y + C - font * 0.65); ctx.fillText(labels.after, ax0 + font * 0.4, y + C - font * 0.65);
      // 메모
      ctx.fillStyle = '#111'; ctx.font = `${font}px ${FONT_STACK}`; ctx.textBaseline = 'top';
      r.lines.forEach((ln, k) => ctx.fillText(ln, ax0 + C + gap, y + k * lh + Math.round(font * 0.1)));
      y += r.h;
      ctx.strokeStyle = '#e5e5e5'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad, y - gap / 2); ctx.lineTo(IW - pad, y - gap / 2); ctx.stroke();
    });
    const blob = await new Promise(res => cv.toBlob(res, 'image/jpeg', JPEG_QUALITY));
    cv.width = cv.height = 1;
    return blob;
  } finally { bB.close(); bA.close(); }
}

/* ================= readme / 목록 텍스트 ================= */
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function fmtDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

function buildTexts({ title, labels, photos, feedback, date, scopeAll }) {
  const withFb = photos.filter(p => (feedback[p.name] || []).length);
  const total = withFb.reduce((s, p) => s + feedback[p.name].length, 0);
  const steps = [
    `1) "피드백 목록.txt" 에서 수정 요청 사진과 건수를 확인합니다.`,
    `2) "feedback" 폴더의 이미지를 엽니다. ${labels.after} 위에 번호 핀이 있고, 아래에 번호별 ${labels.before}/${labels.after} 비교 크롭과 메모가 있습니다.`,
    `3) 더 정밀하게 비교하려면 index.html 을 브라우저(Chrome/Edge)로 엽니다. 사진을 클릭하면 나란히/겹쳐보기, 확대, 핀 클릭으로 메모를 볼 수 있습니다.`,
  ];
  const folders = [
    ['readme.html / readme.txt', '이 안내'],
    ['피드백 목록.txt', '사진별 수정 요청 전체 목록 (체크리스트)'],
    ['feedback/', `${labels.after} 위에 핀과 메모를 그려 넣은 이미지 (피드백 있는 사진만)`],
    ['before/', `${labels.before} (긴 변 3000px 프리뷰)`],
    ['after/', `${labels.after} (긴 변 3000px 프리뷰)`],
    ['index.html', `읽기 전용 비교 뷰어 (style.css, app.js, photos.js, data/, img/ 는 뷰어 구성 파일)`],
  ];
  const numbering = `번호는 사진마다 1부터이며 뷰어·feedback 이미지·목록 파일에서 모두 같습니다. 회신할 때 "파일명 #번호" 로 지칭하면 됩니다.`;
  const hdr = `${title} — 보정 피드백 (${fmtDate(date)})`;
  const scopeLine = scopeAll ? `포함 사진 ${photos.length}장 중 수정 요청 ${withFb.length}장, 총 ${total}건` : `수정 요청 사진 ${withFb.length}장, 총 ${total}건`;

  const listTxt = ['﻿' + hdr, scopeLine, '', '수정 요청 사진 체크리스트', ...withFb.map(p => `[ ] ${p.name} (${feedback[p.name].length}건)`), '', '='.repeat(60)];
  withFb.forEach(p => {
    listTxt.push('', `[${p.name}]  피드백 ${feedback[p.name].length}건   → feedback/${p.name}`);
    feedback[p.name].forEach((fb, i) => { listTxt.push(`  [ ] #${i + 1}`); fb.text.split('\n').forEach(l => listTxt.push(`      ${l}`)); });
  });
  listTxt.push('', numbering);
  const readmeTxt = ['﻿' + hdr, scopeLine, '', '보는 순서', ...steps, '', '폴더 구성', ...folders.map(([k, v]) => `  ${k.padEnd(24)} ${v}`), '', numbering, '',
    'index.html 이 열리지 않으면: 파일을 Chrome 또는 Edge 창으로 끌어다 놓으세요. 인터넷 연결은 필요 없습니다.'];
  const readmeHtml = `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>${esc(hdr)}</title>
<style>body{font-family:-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;max-width:860px;margin:40px auto;padding:0 20px;line-height:1.6;color:#222}
h1{font-size:22px}h2{font-size:17px;margin-top:28px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:6px 10px;text-align:left;vertical-align:top}
th{background:#f5f5f5}code{background:#f3f3f3;padding:1px 5px;border-radius:3px}.big{display:inline-block;background:#e8c27a;color:#111;padding:10px 18px;border-radius:8px;font-weight:700;text-decoration:none}
pre{white-space:pre-wrap;margin:0;font:inherit}ol li{margin:4px 0}</style></head><body>
<h1>${esc(hdr)}</h1><p>${esc(scopeLine)}</p>
<p><a class="big" href="index.html">비교 뷰어 열기 (index.html)</a> &nbsp; <a href="feedback/">feedback 폴더</a> &nbsp; <a href="${encodeURIComponent('피드백 목록.txt')}">피드백 목록.txt</a></p>
<h2>보는 순서</h2><ol>${steps.map(s => `<li>${esc(s.replace(/^\d\) /, ''))}</li>`).join('')}</ol>
<h2>폴더 구성</h2><table><tr><th>항목</th><th>내용</th></tr>${folders.map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${esc(v)}</td></tr>`).join('')}</table>
<p>${esc(numbering)}</p>
<h2>수정 요청 목록</h2>
${withFb.map(p => `<h3>${esc(p.name)} <small>(${feedback[p.name].length}건) · <a href="feedback/${encodeURIComponent(p.name)}">주석 이미지</a> · <a href="index.html#compare/${encodeURIComponent(p.name)}">뷰어에서 열기</a></small></h3>
<table><tr><th style="width:50px">#</th><th>메모</th></tr>${feedback[p.name].map((fb, i) => `<tr><td>${i + 1}</td><td><pre>${esc(fb.text)}</pre></td></tr>`).join('')}</table>`).join('')}
<p style="color:#888;margin-top:40px">생성: ${esc(date.toLocaleString('ko-KR'))} · photo-feedback</p></body></html>`;
  return { readmeHtml, readmeTxt: readmeTxt.join('\r\n'), listTxt: listTxt.join('\r\n'), withFb, total };
}

/* ================= 진입점 ================= */
async function run({ photos, feedback, labels, title, scope = 'fb', onProgress = () => {} }) {
  if (location.protocol === 'file:') throw new Error('file:// 로 연 상태에서는 내보낼 수 없습니다. serve.py 로 띄운 주소에서 실행하세요.');
  const date = new Date();
  const scopeAll = scope === 'all';
  const sel = photos.filter(p => scopeAll || (feedback[p.name] || []).length);
  if (!sel.length) throw new Error('내보낼 사진이 없습니다 (피드백이 없음).');
  const fbSel = {}; sel.forEach(p => { if ((feedback[p.name] || []).length) fbSel[p.name] = feedback[p.name]; });
  const step = (phase, done, total) => onProgress({ phase, done, total });

  // 1. 뷰어 파일
  step('뷰어 파일', 0, 1);
  const [html, css, js] = await Promise.all(['index.html', 'style.css', 'app.js'].map(f => fetchWithRetry(f, 'text')));
  const htmlOut = html.replace(/\s*<script src="export\.js"><\/script>/, '');     // 내보낸 뷰어에는 내보내기 코드 불필요
  const photosJs = 'window.PHOTOS = ' + JSON.stringify({
    readonly: true, title, labels, exported: date.toISOString(),
    paths: { thumb: 'img/thumb', before: 'before', after: 'after' }, photos: sel }) + ';\n';
  const feedbackJs = 'window.FEEDBACK_DATA = ' + JSON.stringify({ version: 1, updated: date.toISOString(), photos: fbSel }) + ';\n';
  const texts = buildTexts({ title, labels, photos: sel, feedback: fbSel, date, scopeAll });
  const entries = [
    { name: 'readme.html', data: texts.readmeHtml }, { name: 'readme.txt', data: texts.readmeTxt },
    { name: '피드백 목록.txt', data: texts.listTxt },
    { name: 'index.html', data: htmlOut }, { name: 'style.css', data: css }, { name: 'app.js', data: js },
    { name: 'photos.js', data: photosJs }, { name: 'data/feedback.js', data: feedbackJs },
  ];

  // 2. 이미지 수집 (동시 3개, 재시도)
  const jobs = [];
  sel.forEach(p => { jobs.push(['img/thumb', p]); jobs.push(['before', p]); jobs.push(['after', p]); });
  const srcDir = { 'img/thumb': 'img/thumb', before: 'img/before', after: 'img/after' };
  let done = 0; step('이미지 수집', 0, jobs.length);
  const blobs = {};
  await mapLimit(jobs, FETCH_CONCURRENCY, async ([dir, p]) => {
    const b = await fetchWithRetry(`${srcDir[dir]}/${encodeURIComponent(p.name)}`);
    (blobs[p.name] ||= {})[dir] = b; step('이미지 수집', ++done, jobs.length);
  });
  sel.forEach(p => ['img/thumb', 'before', 'after'].forEach(dir => entries.push({ name: `${dir}/${p.name}`, data: blobs[p.name][dir] })));

  // 3. 주석 이미지 (직렬 — 메모리)
  const fbPhotos = sel.filter(p => fbSel[p.name]);
  for (let i = 0; i < fbPhotos.length; i++) {
    const p = fbPhotos[i]; step('피드백 이미지 생성', i, fbPhotos.length);
    entries.push({ name: `feedback/${p.name}`, data: await renderAnnotated(p, fbSel[p.name], blobs[p.name].before, blobs[p.name].after, labels) });
  }
  step('피드백 이미지 생성', fbPhotos.length, fbPhotos.length);

  // 4. ZIP
  step('ZIP 생성', 0, entries.length);
  const blob = await buildZip(entries, (d, t) => step('ZIP 생성', d, t));
  const safeTitle = NFC(title || 'photo-feedback').replace(/[\\/:*?"<>|]+/g, '_').trim();
  return { blob, filename: `${safeTitle}_피드백_${fmtDate(date)}.zip`,
           stats: { photos: sel.length, withFeedback: texts.withFb.length, feedback: texts.total, bytes: blob.size } };
}

window.PhotoExport = { run, buildZip, crc32 };
})();
