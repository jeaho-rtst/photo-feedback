#!/usr/bin/env python3
"""
원본(보정 전) / 보정본(보정 후) 사진에서 웹용 자산을 생성한다.

  <app>/img/thumb/<name>.jpg   : 보정본 섬네일 (긴 변 --thumb px, 기본 480)
  <app>/img/before/<name>.jpg  : 보정 전 프리뷰 (긴 변 --preview px, 기본 3000)
  <app>/img/after/<name>.jpg   : 보정본 프리뷰
  <app>/photos.json, photos.js : 사진 목록 + 원본 크기 + 크롭 정렬 정보 (+ 화면 라벨)

실행 예:
  python3 tools/build_assets.py                          # <app 의 상위 폴더>/보정 전, /보정 1차 를 사용
  python3 tools/build_assets.py --before 원본 --after 보정본 --label-after "2차 보정본" --title "홍길동·김영희 웨딩"
  python3 tools/build_assets.py --root /path/to/photos --force

이미 생성된 파일은 원본보다 최신이면 건너뛴다 (--force 로 강제 재생성). 처리 도중 끊겨도
photos.json 이 중간 저장되므로 다시 실행하면 이어서 처리한다.
필요 패키지: Pillow, numpy
"""
import os, sys, json, argparse, unicodedata as u
from concurrent.futures import ProcessPoolExecutor

try:
    import numpy as np
    from PIL import Image, ImageOps
except ImportError:
    sys.exit('Pillow 와 numpy 가 필요합니다:  pip install Pillow numpy')

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument('--root', default=os.path.dirname(APP), help='사진 폴더들이 있는 상위 디렉토리 (기본: 이 앱 폴더의 상위)')
ap.add_argument('--before', default='보정 전', help='보정 전 사진 폴더 이름 (--root 기준)')
ap.add_argument('--after', default='보정 1차', help='보정본 사진 폴더 이름 (--root 기준)')
ap.add_argument('--label-before', default='보정 전', help='화면에 표시할 보정 전 라벨')
ap.add_argument('--label-after', default='1차 보정본', help='화면에 표시할 보정본 라벨')
ap.add_argument('--title', default='', help='화면 제목·내보내기 ZIP 이름에 쓸 프로젝트 이름 (예: "홍길동·김영희 웨딩")')
ap.add_argument('--thumb', type=int, default=480, help='섬네일 긴 변 px')
ap.add_argument('--preview', type=int, default=3000, help='프리뷰 긴 변 px (확대 비교용)')
ap.add_argument('--workers', type=int, default=4)
ap.add_argument('--force', action='store_true', help='이미 있는 생성물도 다시 만든다')
ARGS = ap.parse_args()


def find_dir(root, name):
    """한글 폴더명의 NFC/NFD(macOS) 차이를 무시하고 폴더를 찾는다."""
    want = u.normalize('NFC', name)
    for d in os.listdir(root):
        if u.normalize('NFC', d) == want and os.path.isdir(os.path.join(root, d)):
            return os.path.join(root, d)
    raise SystemExit(f'폴더를 찾을 수 없음: {os.path.join(root, name)}')


BEFORE, AFTER = find_dir(ARGS.root, ARGS.before), find_dir(ARGS.root, ARGS.after)


def newer(dst, src):
    return (not ARGS.force) and os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src)


def save_resized(src, dst, long_edge, quality):
    if newer(dst, src):
        return
    im = Image.open(src); im.draft('RGB', (long_edge * 2, long_edge * 2))
    im = ImageOps.exif_transpose(im).convert('RGB')
    im.thumbnail((long_edge, long_edge), Image.LANCZOS)
    im.save(dst, 'JPEG', quality=quality, optimize=True, progressive=True)


def gray_small(path, w):
    im = Image.open(path); im.draft('L', (w * 2, w * 2))
    im = ImageOps.exif_transpose(im).convert('L')
    h = max(1, round(im.height * w / im.width))
    return np.asarray(im.resize((w, h), Image.BOX), dtype=np.float32)


def norm(a):
    a = a - a.mean(); s = a.std()
    return a / s if s > 1e-6 else a


def align(before, after):
    """보정본(크롭본)이 보정 전 사진 안의 어느 사각형인지 그레이스케일 템플릿 매칭으로 찾는다.
    반환: 보정 전 기준 정규화 좌표 {x,y,w,h} (0~1) 와 매칭 점수(작을수록 좋음, 0.3 이상이면 의심)."""
    B = gray_small(before, 240)
    A_full = Image.open(after); A_full.draft('L', (480, 480)); A_full = ImageOps.exif_transpose(A_full).convert('L')
    ar = A_full.width / A_full.height
    best = (1e9, None)
    Bh, Bw = B.shape
    for w in range(int(Bw * 0.45), Bw + 1, 2):
        h = round(w / ar)
        if h > Bh or h < 8:
            continue
        A = norm(np.asarray(A_full.resize((w, h), Image.BOX), dtype=np.float32))
        for y in range(0, Bh - h + 1, 2):
            for x in range(0, Bw - w + 1, 2):
                d = np.mean((norm(B[y:y + h, x:x + w]) - A) ** 2)
                if d < best[0]:
                    best = (d, (x, y, w, h))
    d, (x, y, w, h) = best
    A = norm(np.asarray(A_full.resize((w, h), Image.BOX), dtype=np.float32))
    for yy in range(max(0, y - 2), min(Bh - h, y + 2) + 1):          # 1px 단위 미세 조정
        for xx in range(max(0, x - 2), min(Bw - w, x + 2) + 1):
            dd = np.mean((norm(B[yy:yy + h, xx:xx + w]) - A) ** 2)
            if dd < d:
                d, x, y = dd, xx, yy
    return {'x': x / Bw, 'y': y / Bh, 'w': w / Bw, 'h': h / Bh, 'score': round(float(d), 4)}


def load_cache():
    try:
        with open(os.path.join(APP, 'photos.json'), encoding='utf-8') as f:
            return {p['name']: p for p in json.load(f)['photos']}
    except Exception:
        return {}


CACHE = load_cache()


def process(name):
    b, a = os.path.join(BEFORE, name), os.path.join(AFTER, name)
    if name in CACHE and all(newer(os.path.join(APP, 'img', k, name), src)
                             for k, src in (('thumb', a), ('before', b), ('after', a))):
        return CACHE[name]
    save_resized(a, os.path.join(APP, 'img/thumb', name), ARGS.thumb, 80)
    save_resized(b, os.path.join(APP, 'img/before', name), ARGS.preview, 86)
    save_resized(a, os.path.join(APP, 'img/after', name), ARGS.preview, 86)
    sb = ImageOps.exif_transpose(Image.open(b)).size
    sa = ImageOps.exif_transpose(Image.open(a)).size
    entry = {'name': name, 'before': {'w': sb[0], 'h': sb[1]}, 'after': {'w': sa[0], 'h': sa[1]}}
    if sb != sa:
        entry['cropped'] = True
        entry['align'] = align(b, a)
    return entry


def write_index(photos):
    data = {'generated_from': {'before': ARGS.before, 'after': ARGS.after},
            'labels': {'before': ARGS.label_before, 'after': ARGS.label_after},
            'title': ARGS.title,
            'photos': photos}
    with open(os.path.join(APP, 'photos.json'), 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    # file:// 로 열어도 fetch 없이 읽을 수 있도록 JS 로도 저장 (index.html 이 사용)
    with open(os.path.join(APP, 'photos.js'), 'w', encoding='utf-8') as f:
        f.write('// tools/build_assets.py 가 생성한 파일. 직접 수정하지 말 것.\nwindow.PHOTOS = '
                + json.dumps(data, ensure_ascii=False) + ';\n')


if __name__ == '__main__':
    for sub in ('thumb', 'before', 'after'):
        os.makedirs(os.path.join(APP, 'img', sub), exist_ok=True)
    exts = ('.jpg', '.jpeg', '.png', '.webp')
    names = sorted(f for f in os.listdir(BEFORE) if f.lower().endswith(exts)
                   and os.path.exists(os.path.join(AFTER, f)))
    if not names:
        sys.exit(f'두 폴더에 같은 이름으로 들어 있는 사진이 없습니다: {BEFORE} / {AFTER}')
    missing = sorted(f for f in os.listdir(AFTER) if f.lower().endswith(exts) and f not in names)
    if missing:
        print('보정 전 폴더에 짝이 없는 보정본(무시):', missing)
    photos = []
    with ProcessPoolExecutor(ARGS.workers) as ex:
        for p in ex.map(process, names):
            photos.append(p)
            write_index(photos)          # 중간 저장: 긴 작업이 끊겨도 다음 실행에서 이어서 처리
    write_index(photos)
    print(f'{len(photos)}장 처리 완료, 크롭 {sum(1 for p in photos if p.get("cropped"))}장')
