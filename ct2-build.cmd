@echo off
call "C:\Program Files\Microsoft Visual Studio\18\Insiders\VC\Auxiliary\Build\vcvarsall.bat" x64
if errorlevel 1 exit /b %errorlevel%
REM ponytail: backend + OpenMP policy is now centralised in
REM electron/native/ctranslate2-server/CMakeLists.txt (oneDNN vendored
REM via FetchContent on Windows; Accelerate on macOS). All the old `-DWITH_*`
REM flags that used to live here were redundant (CTranslate2 v4.4.0
REM doesn't read the `CTRANS2_`-prefixed versions anyway, and our
REM vendor block CACHE-FORCEs the right names). Override on the CLI only
REM for one-off experiments.
cmake -S electron\native\ctranslate2-server -B .cache\ctranslate2-build\build-cpu -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DCMAKE_MAKE_PROGRAM="C:\Program Files\Microsoft Visual Studio\18\Insiders\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe"
if errorlevel 1 exit /b %errorlevel%
cmake --build .cache\ctranslate2-build\build-cpu --config Release --target ctranslate2-server
if errorlevel 1 exit /b %errorlevel%
REM ponytail: full static link — no DLL sidecar. Single self-contained .exe
REM per platform is the simplest distribution story; older builds were
REM broken because the exe loaded a stale ctranslate2.dll from the bin
REM dir. With `BUILD_SHARED_LIBS=OFF` in the CMakeLists there is no dll
REM to forget.
copy /Y .cache\ctranslate2-build\build-cpu\ctranslate2-server.exe electron\native\bin\win32-x64\ctranslate2-server-ctranslate2-cpu.exe
echo Build complete.
