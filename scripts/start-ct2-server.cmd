@echo off
REM Boot the ctranslate2-server with a fresh model_dir and redirect logs.
setlocal
set "OPENSCREEN_CT2_MODEL_DIR=G:\repos\openscreen\.claude\worktrees\stt-migration\.cache\model\whisper-small-ct2"
start "" /B "G:\repos\openscreen\.claude\worktrees\stt-migration\.cache\ctranslate2-build\ctranslate2-server.exe" --port 20199 --threads 4 ^>^> "G:\repos\openscreen\.claude\worktrees\stt-migration\ct2-bg.log" 2^>^&^1
