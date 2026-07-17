@echo off
call "C:\Program Files\Microsoft Visual Studio\18\Insiders\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
cd /d "%~dp0"
cl /nologo /EHsc nv12_probe.cpp /Fe:nv12_probe.exe >nv12_build.log 2>&1 || (type nv12_build.log & exit /b 1)
nv12_probe.exe
