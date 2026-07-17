@echo off
call "C:\Program Files\Microsoft Visual Studio\18\Insiders\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
cd /d "%~dp0"
cl /nologo /EHsc /O2 d2d_probe.cpp /Fe:d2d_probe.exe >build.log 2>&1
if errorlevel 1 (
  echo BUILD_FAILED
  type build.log
  exit /b 1
)
echo BUILD_OK
d2d_probe.exe
