$root = 'G:\repos\openscreen\.claude\worktrees\stt-migration'
$buildDir = Join-Path $root '.cache\ctranslate2-build'
if (Test-Path $buildDir) {
  Remove-Item -Recurse -Force $buildDir
}
New-Item -ItemType Directory -Path $buildDir -Force | Out-Null

$vcvars = 'C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat'
$srcDir = Join-Path $root 'electron\native\ctranslate2-server'

$cmd = "`"$vcvars`" && cmake -G Ninja -DCMAKE_BUILD_TYPE=Release -DENABLE_CUDA=OFF -DWITH_BLAS=ON -DWITH_MKL=OFF -DWITH_DNNL=OFF -DWITH_RUY=ON -DWITH_OPENBLAS=ON -DWITH_ACCELERATE=OFF -DOPENMP_RUNTIME=NONE -DCMAKE_BUILD_TESTS=OFF -DCMAKE_BUILD_EXAMPLES=OFF -DCMAKE_BUILD_TOOLS=OFF -DBUILD_CLI=OFF -DCMAKE_BUILD_PYTHON=OFF -DCMAKE_PREFIX_PATH=`"G:/repos/openscreen/.claude/worktrees/stt-migration/.cache/openblas`" -DCMAKE_INSTALL_PREFIX=`"`" -S `"$srcDir`" -B `"$buildDir`""

$output = cmd.exe /c $cmd 2>&1
$output | Out-File -FilePath (Join-Path $buildDir 'configure.log')
$output | ForEach-Object { Write-Host $_ }
Write-Host "exit code: $LASTEXITCODE"
Write-Host "log at $buildDir\configure.log"
