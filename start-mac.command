#!/bin/bash
# macOS: 더블클릭하면 피드백 서비스를 띄우고 브라우저를 연다. (처음 한 번 '열기' 보안 허용이 필요할 수 있음)
cd "$(dirname "$0")"
python3 serve.py
