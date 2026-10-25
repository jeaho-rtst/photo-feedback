#!/usr/bin/env python3
"""
피드백 서비스를 로컬 웹서버로 띄운다. 이 모드에서는 피드백이 브라우저가 아니라
<app>/data/feedback.json 파일에 자동 저장되므로, 공유 폴더(SMB, Synology Drive 등)에 두면
다른 PC 에서도 같은 피드백을 이어서 볼 수 있다. 표준 라이브러리만 사용한다 (Python 3.7+).

실행:  python3 serve.py                 (어느 위치에서 실행해도 됨)
옵션:  --port 8765      포트
       --host 0.0.0.0   LAN 의 다른 기기에서 접속 허용 (NAS 에서 띄울 때). 기본 127.0.0.1 (내 PC 만)
       --no-open        브라우저 자동 열기 끄기
       --build          시작 전에 tools/build_assets.py 실행 (새 사진이 추가됐을 때)
주의: 인증이 없다. 집/사무실 LAN 안에서만 쓰고 인터넷에 직접 노출하지 말 것.

NAS 상시 실행 예 (Synology DSM 7, 제어판 > 작업 스케줄러 > 트리거된 작업 "부팅 시", root):
  python3 "/volume1/photos/wedding/photo-feedback/serve.py" --host 0.0.0.0 --no-open
"""
import argparse, json, os, sys, threading, webbrowser, subprocess
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

APP = os.path.dirname(os.path.abspath(__file__))
APP_NAME = os.path.basename(APP)            # 서빙 URL 의 첫 경로 (폴더 이름을 바꿔도 동작)
DATA_DIR = os.path.join(APP, 'data')
FEEDBACK_JSON = os.path.join(DATA_DIR, 'feedback.json')
FEEDBACK_JS = os.path.join(DATA_DIR, 'feedback.js')


def read_feedback():
    try:
        with open(FEEDBACK_JSON, encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return {'version': 1, 'photos': {}}


def write_feedback(data):
    """원자적으로 저장: 임시 파일에 쓴 뒤 교체 (동기화 도중 깨진 파일이 남지 않게)."""
    os.makedirs(DATA_DIR, exist_ok=True)
    body = json.dumps(data, ensure_ascii=False, indent=1)
    for path, content in ((FEEDBACK_JSON, body),
                          (FEEDBACK_JS, '// serve.py 가 생성. file:// 로 열었을 때 읽기용 사본.\nwindow.FEEDBACK_DATA = ' + body + ';\n')):
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write(content)
        os.replace(tmp, path)


def make_handler(root):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=root, **kw)

        def log_message(self, fmt, *args):      # 이미지 요청 로그는 조용히, API 만 출력
            if '/api/' in str(args[0] if args else ''):
                super().log_message(fmt, *args)

        def end_headers(self):
            self.send_header('Cache-Control', 'no-store')
            super().end_headers()

        def do_GET(self):
            if self.path.split('?')[0] == '/api/feedback':
                return self._json(200, read_feedback())
            if self.path in ('/', ''):
                self.send_response(302); self.send_header('Location', f'/{APP_NAME}/'); self.end_headers(); return
            super().do_GET()

        def do_PUT(self):
            if self.path.split('?')[0] != '/api/feedback':
                return self._json(404, {'error': 'not found'})
            try:
                n = int(self.headers.get('Content-Length', 0))
                data = json.loads(self.rfile.read(n).decode('utf-8'))
                if not isinstance(data, dict) or not isinstance(data.get('photos'), dict):
                    raise ValueError('형식 오류: {"version":1,"photos":{...}} 이어야 함')
                write_feedback(data)
                self._json(200, {'ok': True, 'total': sum(len(v) for v in data['photos'].values())})
            except Exception as e:
                self._json(400, {'error': str(e)})

        def _json(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
    return Handler


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--root', default=os.path.dirname(APP),
                    help='서빙 루트 (기본: 이 앱 폴더의 상위). 앱은 /<앱 폴더 이름>/ 경로로 서빙된다')
    ap.add_argument('--no-open', action='store_true')
    ap.add_argument('--build', action='store_true')
    ap.add_argument('build_args', nargs=argparse.REMAINDER,
                    help='--build 뒤에 붙이는 인자는 tools/build_assets.py 로 그대로 전달 (예: --build -- --before 원본)')
    a = ap.parse_args()
    if a.build or not os.path.exists(os.path.join(APP, 'photos.js')):
        print('섬네일/목록 생성 중... (tools/build_assets.py)')
        extra = [x for x in a.build_args if x != '--']
        subprocess.run([sys.executable, os.path.join(APP, 'tools', 'build_assets.py'), *extra], check=False)
    url = f'http://127.0.0.1:{a.port}/{APP_NAME}/'
    srv = ThreadingHTTPServer((a.host, a.port), make_handler(os.path.abspath(a.root)))
    print(f'피드백 서비스 실행 중: {url}' + (f'  (LAN: http://<이 기기 IP>:{a.port}/{APP_NAME}/)' if a.host == '0.0.0.0' else '')
          + f'\n피드백 저장 위치: {FEEDBACK_JSON}\n종료: Ctrl+C')
    if not a.no_open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n종료')


if __name__ == '__main__':
    main()
