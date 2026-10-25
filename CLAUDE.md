# CLAUDE.md — photo-feedback 작업 가이드

이 파일은 코딩 에이전트(와 사람)가 이 리포를 수정할 때 알아야 할 것을 모아둔 것이다. 사용법은 README.md 참고.

## 한 줄 요약
보정 전/후 사진 쌍을 비교하며 사진 위 좌표에 메모(피드백)를 남기는 도구. 프런트는 빌드 없는 바닐라 JS 3개 파일,
백엔드는 파이썬 표준 라이브러리만 쓰는 정적 서버 + JSON 저장 API 하나. 의존성은 자산 생성 스크립트의 Pillow/numpy 뿐.

## 파일별 역할
| 파일 | 역할 |
|---|---|
| `index.html` | 마크업. 인덱스 뷰(`#view-index`)와 비교 뷰(`#view-compare`) 두 섹션, 팝업/팝오버. `data-label` 속성이 붙은 요소는 시작 시 `LABELS` 로 치환됨 |
| `style.css` | 다크 테마 스타일. CSS 변수는 `:root` |
| `app.js` | 전체 로직. IIFE 하나, 전역 노출 없음. 섹션: 저장소 → 라우팅 → 인덱스 → 뷰어(줌/팬) → 모드 → 피드백 추가/핀/팝오버/목록 → 백업/가져오기 → ZIP 모달 → 시작 |
| `export.js` | 업체 전달용 ZIP 내보내기. `window.PhotoExport.run({photos, feedback, labels, title, scope, onProgress})` 하나만 노출. store 방식 ZIP writer(CRC32), Canvas 주석 이미지, readme/목록 텍스트 생성. 내보낸 ZIP 에는 포함되지 않는다 |
| `serve.py` | `ThreadingHTTPServer`. `--root`(기본: 앱 폴더의 상위)를 서빙하고 `/api/feedback` GET/PUT 제공. `/` 는 `/<앱 폴더명>/` 으로 302 |
| `tools/build_assets.py` | 원본 → `img/thumb|before|after/` 와 `photos.json` + `photos.js`. 크롭된 보정본의 정렬 사각형 계산 |
| `start-mac.command`, `start-windows.bat` | 더블클릭용 런처. `serve.py` 호출만 함 |
| `data/feedback.json` | 서버 모드 저장소. `data/feedback.js` 는 같은 내용의 `window.FEEDBACK_DATA = …` (file:// 읽기용). 둘 다 `serve.py` 가 원자적으로 씀 |

생성물(`img/`, `photos.js`, `photos.json`, `data/`)은 `.gitignore` 되어 있다. 리포에는 코드와 문서만 들어간다.

## 내보낸 ZIP (업체 전달용) 의 구조와 읽기 전용 뷰어
```
readme.html, readme.txt, 피드백 목록.txt      ← export.js 의 buildTexts() 가 한 데이터에서 셋 다 생성
index.html, style.css, app.js                 ← 서비스 파일을 fetch 해 그대로 복사 (index.html 에서 export.js 태그만 제거)
photos.js                                     ← {readonly:true, title, labels, paths:{thumb,before,after}, photos:[선택된 것만]}
data/feedback.js                              ← window.FEEDBACK_DATA (선택된 사진만)
img/thumb/, before/, after/                   ← 서비스의 img/thumb, img/before, img/after 를 그대로 복사 (폴더명만 ASCII 로)
feedback/<이름>.jpg                            ← 피드백 있는 사진만. 보정본(긴 변 2000) + 번호 핀 + 번호별 보정 전/보정본 비교 크롭 + 메모 패널
```
- 최상위 폴더를 넣지 않는다 (Windows "압축 풀기" 가 zip 이름 폴더를 또 만들어 이중 폴더가 되므로).
- 폴더/파일명은 NFC 로 정규화하고 ZIP 헤더에 UTF-8 플래그(0x800)를 세운다. 폴더명이 ASCII 인 이유: macOS 에서 온 NFD 한글과 구형 압축 도구 호환.
- 읽기 전용은 `photos.js` 의 `readonly:true` 하나로 결정된다. app.js 는 시작 시 `body.readonly` 클래스를 붙이고, 편집 UI 는 전부 `data-edit`
  속성을 달아 CSS 한 줄(`.readonly [data-edit]{display:none}`)로 숨기며, 상태 변경은 `store.add/update/remove/save` 입구에서 막는다.
  **새 편집 UI 를 추가하면 반드시 `data-edit` 를 붙일 것.** 읽기 전용에서는 localStorage 도 쓰지 않고 `FEEDBACK_DATA` 만 읽는다.
- 이미지 경로는 `PATHS`(photos.js 의 `paths`)에서 온다. 서비스에서는 기본값 `img/*`, 내보낸 뷰어에서는 `before/after`.
- 내보내기는 `fetch` 를 쓰므로 서버 모드에서만 가능하다. file:// 에서는 버튼을 비활성화한다 (`store.setStatus('local')`).
- 메모리: 이미지는 `Blob` 그대로 ZIP parts 에 넣고(복사 없음) CRC 계산 때만 `arrayBuffer()` 로 한 번 읽는다. 주석 이미지는 직렬로
  `createImageBitmap → canvas → toBlob → bitmap.close()`. fetch 는 동시 3개·재시도 3회·60초 타임아웃 (NAS 가 느림).
- 서버 측 이미지 처리(Pillow 등)는 의도적으로 두지 않는다 — NAS 내장 python3 호환이 목표.

## 실행·검증
```bash
python3 tools/build_assets.py --root /path/with/photo/folders      # Pillow, numpy 필요
python3 serve.py --no-open --port 8765                                # http://127.0.0.1:8765/photo-feedback/
python3 -m py_compile serve.py tools/build_assets.py                  # 문법 확인
```
자동 테스트는 없다. 변경 후에는 실제 브라우저(Playwright 또는 Chrome)로 다음을 확인한다:
인덱스 카드 50장 렌더 → 카드 클릭으로 비교 뷰 → Ctrl+휠 줌 후 양쪽 `.stage` 의 `style.transform`/`width` 가 같은지 →
오른쪽 pane 클릭 시 `#add-popup` 이 오른쪽에 뜨는지 → 메모 저장 후 `/api/feedback` 에 반영 → 수정/삭제 → 겹쳐보기 전환 →
`#btn-pins` 토글 → 사진 30장 이상 연속 전환(메모리) → `file://` 로 열었을 때 노란 "이 브라우저에만 저장됨" 상태.
`confirm()` 을 쓰는 삭제는 자동화에서 `window.confirm = () => true` 로 우회한다.
내보내기를 바꿨으면: ZIP 을 내려받아 `python3 -c "import zipfile; z=zipfile.ZipFile('x.zip'); print(z.testzip()); [print(i.filename, i.flag_bits & 0x800) for i in z.infolist()]"`
로 CRC·UTF-8 플래그를 확인하고, 압축을 푼 `index.html` 을 file:// 로 열어 `body.readonly`, 핀/목록 표시, 클릭해도 추가 팝업이 안 뜨는지, `feedback/*.jpg` 를 눈으로 본다.

## 핵심 설계 (바꾸기 전에 읽을 것)
- **좌표계**: "캔버스" = 보정 전 사진을 0~1 로 정규화한 공간. 피드백 `x,y` 도 이 기준. 보정본은 `photos.js` 의
  `align {x,y,w,h}` 사각형 안에 배치되므로(크롭이 없으면 전체), 나란히/겹쳐보기 모두 같은 피사체가 같은 자리에 온다.
  내보내기 때 보정본 기준 좌표는 `(x - align.x) / align.w` 로 환산한다.
- **줌/팬 상태는 하나**: `view = {z, cx, cy}` 를 모든 pane 이 공유한다. `z=1` 이 화면 맞춤, 최대 `MAX_ZOOM=8`.
  `layout()` 이 pane 마다 `fitSize()` 로 맞춤 크기를 구해 stage/img 의 실제 px 크기를 `z` 배로 잡고 `translate` 만 적용한다.
- **CSS `scale()` 로 확대하지 말 것**: 과거에 `transform: scale(z)` + `will-change` 를 썼다가 Chrome 이 pane 밖까지 포함한
  8배 크기 레이어를 통째로 래스터라이즈해 사진 몇 장 넘기면 탭이 죽었다. 지금처럼 실제 크기를 키우고 `overflow:hidden` 으로
  잘라야 보이는 타일만 그린다. 핀도 같은 이유로 역스케일 없이 `left/top` 만 갱신한다 (`pin.dataset.x/y` 사용).
- **입력**: 트랙패드 핀치는 브라우저가 `wheel` + `ctrlKey` 로 준다 → 줌. 일반 휠/두 손가락 스크롤 → 팬. Safari 는 `gesturechange`.
  포인터 4px 이상 이동하면 드래그, 아니면 클릭(= 피드백 위치 지정). 핀은 `pointerdown` 에서 `stopPropagation` 해 드래그를 막는다.
- **팝업 위치**: 클릭한 pane 을 `pending.pane` / `openPopover(..., nearPane)` 로 넘겨 그 pane 기준으로 띄운다.
  `anchorPane()` 은 그 pane 이 안 보이면(모드 전환 등) 첫 번째 보이는 pane 으로 대체한다.
- **저장 모드**: `store.mode` 가 `server`(http 로 열고 `/api/feedback` 응답 OK) 또는 `local`(file://). 서버 모드는 localStorage 에도
  사본을 두고 300ms 디바운스로 PUT. 시작 시 서버 파일이 비어 있고 로컬에만 데이터가 있으면 서버로 올린다(file:// 로 쓰다 전환한 경우).
  `file://` 에서는 `data/feedback.js` 와 localStorage 중 `updated` 가 최근인 쪽을 쓴다. 동시 편집 충돌 처리는 의도적으로 없다.
- **file:// 호환**: `fetch` 로 JSON 을 읽지 않는다(Chrome 이 file:// fetch 를 막음). 데이터는 전부 `<script src="photos.js">`,
  `data/feedback.js` 처럼 스크립트로 읽는다. 외부 CDN·빌드 도구도 쓰지 않는다.
- **라벨**: 화면의 "보정 전/보정본" 문구는 `photos.js` 의 `labels` 로 바뀐다(`build_assets.py --label-before/--label-after`).
  마크업에 새 문구를 넣을 때는 `data-label="before|after"` 를 쓰고 하드코딩하지 않는다.

## 알려진 함정
- `aspect-ratio` 나 `padding-bottom: %` 로 섬네일 높이를 잡으면 Chrome 의 grid 행 크기 계산에서 폭 기반 높이가 0 이 되어
  카드가 40px 띠로 보인다. 섬네일 박스는 고정 높이(`.card .thumb { height: 150px }`)를 유지할 것.
- `[hidden]` 은 CSS 에서 `display: … !important` 로 강제해 두었다. `display:flex` 같은 규칙이 `hidden` 속성을 이기기 때문.
- 한글 폴더명은 macOS(SMB 포함)가 NFD, Windows/Linux 가 NFC 로 보고한다. 코드에서 한글 경로를 직접 비교하지 말고
  `build_assets.py` 의 `find_dir()` 처럼 `unicodedata.normalize('NFC')` 로 비교한다. 생성물 경로는 전부 ASCII.
- `step()` 은 `hashchange` 처리 전에 키 연타가 와도 사진을 건너뛰지 않도록 `currentIdx` 를 즉시 갱신한다.
- 크롭 정렬 `align.score` 가 0.3 이상이면 색 보정이 크거나 미세 회전이 있어 정렬이 어긋났을 수 있다. 회전/원근은 지원하지 않는다.
- `build_assets.py` 는 결과를 `photos.json` 에 중간 저장하며, 이미 최신인 항목은 캐시에서 재사용한다. 정렬 계산은 장당 10~20초.
- 서버는 인증이 없다. `--host 0.0.0.0` 은 LAN 전용이라는 전제로만 쓴다.

## 바꾸지 않을 것
- 의존성 추가(프런트 프레임워크, 서버 프레임워크). 목표는 "폴더에 넣고 더블클릭" 수준의 단순함과 NAS 내장 python3 호환.
- 피드백 JSON 의 기본 구조(`photos[name][] = {id,x,y,text,created,updated}`)와 좌표계. 바꾸면 기존 데이터와 내보내기 소비자가 깨진다.

## 아이디어 / 남은 일
- 내보내기에 Chrome/Edge `showSaveFilePicker` 스트리밍 저장 추가(수백 장 규모 대비). 지금은 Blob 한 번에 조립.
- 정렬 점수가 높은 크롭 사진의 수동 미세 조정 UI.
- Chrome/Edge 의 File System Access API 로 `file://` 모드에서도 json 직접 저장.
- 첫 피드백을 저장하면 하단 목록이 생기며 사진 영역이 줄어 뷰가 살짝 움직인다 — 목록 영역 높이 고정으로 해결 가능.
