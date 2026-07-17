@echo off
REM Enveloppe de build, portable dans le repo (chemins via %~dp0) :
REM   vcvars (INCLUDE/LIB pour libclang + linker MSVC), ffmpeg/bin sur PATH runtime, cargo.
REM Ajuste le chemin vcvars ci-dessous si ta version de Visual Studio diffère.
call "C:\Program Files\Microsoft Visual Studio\18\Insiders\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
set "PATH=%PATH%;%~dp0thirdparty\ffmpeg-master-latest-win64-lgpl-shared\bin"
cd /d "%~dp0"
"%USERPROFILE%\.cargo\bin\cargo.exe" %*
