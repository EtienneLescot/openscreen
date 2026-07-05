@echo off
REM Dev-mode fallback STT server wrapper.
REM Replaces the unbuilt CTranslate2 C++ binary.
REM Accepts the same arguments as the real server but starts the Node.js dev server instead.

set PORT=20199
set MODEL_DIR=

:parse
if "%~1"=="" goto run
if "%~1"=="--model" set MODEL_DIR=%~2& shift & shift & goto parse
if "%~1"=="--port" set PORT=%~2& shift & shift & goto parse
if "%~1"=="--host" shift & shift & goto parse
if "%~1"=="--threads" shift & shift & goto parse
if "%~1"=="--cuda" shift & goto parse
shift
goto parse

:run
start /B "" node "%~dp0..\scripts\stt-dev-server.mjs" --port=%PORT%
echo [ct2-wrapper] Dev STT server started on port %PORT% (model=%MODEL_DIR%)
