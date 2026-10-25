# photo-feedback

사진 보정 전/후를 비교하면서 **사진 위 특정 위치에 수정 요청 메모를 남기는** 작은 웹 도구입니다.
웨딩 스튜디오의 1차 보정본을 검토하려고 만들었지만, "원본 폴더 + 결과물 폴더"가 파일명으로 1:1 대응되는
상황이면 무엇이든 쓸 수 있습니다. 서버 코드는 파이썬 표준 라이브러리만 쓰고, 프런트엔드는 빌드 없는 바닐라 JS 입니다.

A small self-hosted tool for reviewing retouched photos against the originals and pinning feedback notes
on specific spots. Pure-Python server (stdlib only), vanilla JS front-end, no build step. UI is in Korean.

## 기능

- **사진 인덱스**: 보정본 섬네일 그리드, 사진별 피드백 건수 배지, "피드백 있는 사진만" / "크롭된 사진만" 필터
- **나란히 보기**: 왼쪽 보정 전, 오른쪽 보정본. 트랙패드 핀치 / Ctrl+휠 / 슬라이더로 최대 8배 확대, 드래그·두 손가락 스크롤로 이동.
  양쪽이 항상 같은 배율·같은 영역을 보여줍니다.
- **겹쳐보기**: 보정본을 반투명(기본 50%)으로 겹쳐서 어디가 바뀌었는지 확인. 불투명도 슬라이더, 깜빡임(교대 표시), 차이 강조(difference 블렌딩)
- **크롭 자동 정렬**: 보정본이 크롭되어 원본과 크기가 다르면, 생성 스크립트가 템플릿 매칭으로 원본의 어느 영역인지 찾아 맞춰서 보여줍니다
- **위치 기반 피드백**: 사진을 클릭 → "피드백 남기기" → 줄바꿈 가능한 메모. 붉은 번호 핀으로 표시되고 클릭하면 보기/수정/삭제.
  하단 목록에서도 수정/삭제, 핀 보이기/숨기기 토글
- **저장**: 서버 모드에서는 `data/feedback.json` 파일에 자동 저장 (공유 폴더·NAS 에 두면 여러 PC 에서 이어서 작업).
  `file://` 로 그냥 열면 브라우저 localStorage 에만 저장. JSON 내보내기/가져오기 지원

## 빠른 시작

```
사진폴더/
├─ 보정 전/        원본      (FRA01539.jpg …)
├─ 보정 1차/       보정본    (같은 파일명)
└─ photo-feedback/ ← 이 리포를 여기에 clone
```

```bash
cd 사진폴더
git clone https://github.com/jeaho-rtst/photo-feedback.git
pip install Pillow numpy                      # 섬네일/프리뷰 생성에만 필요
python3 photo-feedback/tools/build_assets.py  # img/ 와 photos.js 생성 (수십 장이면 몇 분)
python3 photo-feedback/serve.py               # http://127.0.0.1:8765/photo-feedback/ 가 열림
```

macOS 는 `start-mac.command`, Windows 는 `start-windows.bat` 를 더블클릭해도 됩니다 (Python 3 필요).

폴더 이름이나 라벨이 다르면:

```bash
python3 photo-feedback/tools/build_assets.py --before 원본 --after 결과물 --label-before 원본 --label-after "2차 보정본"
```

### NAS 에서 상시 실행 (예: Synology DSM 7)

`serve.py` 는 표준 라이브러리만 쓰므로 DSM 내장 `python3` 로 바로 돌아갑니다. 제어판 → 작업 스케줄러 → 트리거된 작업("부팅 시", root):

```
python3 "/volume1/photos/wedding/photo-feedback/serve.py" --host 0.0.0.0 --no-open
```

이후 LAN 의 어느 기기에서든 `http://<NAS IP>:8765/photo-feedback/`. 인증이 없으니 **인터넷에 직접 노출하지 마세요.**
섬네일 생성(`build_assets.py`)은 Pillow/numpy 가 필요하므로 PC 에서 돌리고, 결과물이 같은 공유 폴더에 떨어지게 하면 됩니다.

## 단축키

`←` `→` 사진 이동 · `0` 화면 맞춤 · `1` 나란히 · `2` 겹쳐보기 · `Esc` 닫기 · 메모 저장 `⌘/Ctrl+Enter`

## 데이터 형식

`data/feedback.json`

```json
{ "version": 1, "updated": "2026-10-25T13:11:08Z",
  "photos": { "FRA01539.jpg": [ { "id": "fb_…", "x": 0.53, "y": 0.34, "text": "…", "created": "…", "updated": "…" } ] } }
```

`x`, `y` 는 **보정 전 사진** 기준 0~1 정규화 좌표입니다. 사이드바 "내보내기" JSON 에는 사진별 번호와
보정본 기준 좌표(`after.x/y`, 크롭 반영)가 추가로 들어 있어 업체 전달 자료의 출발점으로 쓸 수 있습니다.

## 구조

```
index.html / style.css / app.js   SPA 본체 (프레임워크·빌드 없음)
serve.py                          정적 서빙 + GET/PUT /api/feedback (stdlib)
tools/build_assets.py             원본 → img/thumb|before|after + photos.js (Pillow, numpy)
data/feedback.json                피드백 (서버 모드에서 자동 생성)
```

에이전트/기여자를 위한 설계 메모는 [CLAUDE.md](CLAUDE.md) 에 있습니다.

## 라이선스

MIT
