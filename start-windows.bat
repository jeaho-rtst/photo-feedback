@echo off
rem Windows: 더블클릭하면 피드백 서비스를 띄우고 브라우저를 연다. Python 3 가 설치되어 있어야 한다.
cd /d "%~dp0"
python serve.py || py -3 serve.py
pause
