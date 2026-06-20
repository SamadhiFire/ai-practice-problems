# build_mnn_android.ps1 - Cross-compile MNN for Android (arm64-v8a)
# Usage: .\build_mnn_android.ps1 -NdkPath "C:/Users/xxx/AppData/Local/Android/Sdk/ndk/26.1.10909125"
# Requires: Android NDK r25+, CMake 3.18+, Ninja (recommended)

param(
    [Parameter(Mandatory=$true)]
    [string]$NdkPath,
    [string]$Abi = "arm64-v8a",
    [int]$ApiLevel = 24,
    [string]$NinjaPath = "",
    [switch]$DisableSme2
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DepsDir = $ScriptDir
$MnnDir = Join-Path $DepsDir "MNN"
$MnnSdkDir = Join-Path $DepsDir "mnn-android-sdk"
$PluginJniLibs = Join-Path $DepsDir "mnn-qwen-android-plugin/src/main/jniLibs/$Abi"

function Resolve-NinjaExecutable {
    param([string]$RequestedPath)

    if (-not [string]::IsNullOrWhiteSpace($RequestedPath)) {
        if (-not (Test-Path -LiteralPath $RequestedPath)) {
            throw "Ninja executable not found: $RequestedPath"
        }
        return (Resolve-Path -LiteralPath $RequestedPath).Path
    }

    $command = Get-Command "ninja.exe" -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    $visualStudioRoot = Join-Path $env:ProgramFiles "Microsoft Visual Studio"
    if (Test-Path -LiteralPath $visualStudioRoot) {
        $candidate = Get-ChildItem -LiteralPath $visualStudioRoot -Filter "ninja.exe" -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match "CommonExtensions\\Microsoft\\CMake\\Ninja" } |
            Select-Object -First 1 -ExpandProperty FullName
        if ($candidate) { return $candidate }
    }

    throw "Ninja was not found. Install Ninja, add it to PATH, or pass -NinjaPath <path-to-ninja.exe>."
}

# Toolchain
$Toolchain = Join-Path $NdkPath "build/cmake/android.toolchain.cmake"
if (-not (Test-Path $Toolchain)) {
    Write-Host "ERROR: NDK toolchain not found: $Toolchain" -ForegroundColor Red
    Write-Host "Make sure NDK path is correct, e.g.: C:/Users/xxx/AppData/Local/Android/Sdk/ndk/26.1.10909125" -ForegroundColor Yellow
    exit 1
}
$NinjaExe = Resolve-NinjaExecutable $NinjaPath

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Cross-compile MNN for Android" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " ABI: $Abi" -ForegroundColor White
Write-Host " API: $ApiLevel" -ForegroundColor White
Write-Host " NDK: $NdkPath" -ForegroundColor White
Write-Host " Ninja: $NinjaExe" -ForegroundColor White
Write-Host " SME2: $(if ($DisableSme2) { 'disabled' } else { 'enabled (compile flag requested)' })" -ForegroundColor White
Write-Host ""

# Step 1: Check MNN source
if (-not (Test-Path (Join-Path $MnnDir "CMakeLists.txt"))) {
    Write-Host "ERROR: MNN source not found, run setup_mnn.ps1 first" -ForegroundColor Red
    exit 1
}

# Step 2: CMake config
$BuildDir = Join-Path $MnnDir "build_android"
New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null

Write-Host "[1/4] CMake config..." -ForegroundColor Green
Push-Location $BuildDir
try {
    $cmakeArgs = @(
        "..",
        "-G", "Ninja",
        "-DCMAKE_MAKE_PROGRAM=$NinjaExe",
        "-DCMAKE_TOOLCHAIN_FILE=$Toolchain",
        "-DANDROID_ABI=$Abi",
        "-DANDROID_PLATFORM=android-$ApiLevel",
        "-DANDROID_STL=c++_shared",
        "-DMNN_BUILD_FOR_ANDROID=ON",
        "-DMNN_BUILD_FOR_ANDROID_COMMAND=ON",
        "-DMNN_BUILD_LLM=ON",
        "-DMNN_LLM_BUILD_DEMO=OFF",
        "-DLLM_SUPPORT_HTTP_RESOURCE=OFF",
        "-DMNN_BUILD_TOOLS=OFF",
        "-DMNN_BUILD_TEST=OFF",
        "-DMNN_BUILD_BENCHMARK=OFF",
        "-DMNN_BUILD_CONVERTER=OFF",
        "-DMNN_SEP_BUILD=OFF",
        "-DMNN_USE_LOGCAT=ON",
        "-DMNN_ARM82=ON",
        "-DMNN_LOW_MEMORY=ON",
        "-DMNN_SME2=$(if ($DisableSme2) { 'OFF' } else { 'ON' })",
        "-DCMAKE_BUILD_TYPE=Release"
    )
    if (-not $DisableSme2) {
        $cmakeArgs += "-DCMAKE_C_FLAGS=-march=armv8.6-a+sme2"
        $cmakeArgs += "-DCMAKE_CXX_FLAGS=-march=armv8.6-a+sme2"
    }

    & cmake @cmakeArgs

    if ($LASTEXITCODE -ne 0) { throw "CMake config failed" }
    Write-Host "  OK CMake config done" -ForegroundColor Green

    # Step 3: Build
    Write-Host "[2/4] Building MNN..." -ForegroundColor Green
    cmake --build . --config Release --target MNN -j 8
    if ($LASTEXITCODE -ne 0) { throw "Build failed" }
    Write-Host "  OK Build done" -ForegroundColor Green
} finally {
    Pop-Location
}

# Step 4: Check build output
Write-Host "[3/4] Checking build output..." -ForegroundColor Green
$required = @("libMNN.so")
$allFound = $true

foreach ($lib in $required) {
    $path = Join-Path $BuildDir $lib
    if (Test-Path $path) {
        $size = (Get-Item $path).Length
        Write-Host "  OK $lib ($([math]::Round($size/1MB, 2)) MB)" -ForegroundColor Green
    } else {
        Write-Host "  MISS $lib" -ForegroundColor Red
        $allFound = $false
    }
}

if (-not $allFound) {
    Write-Host "  Some libraries missing, check build log" -ForegroundColor Yellow
    exit 1
}

# Step 5: Copy .so to plugin jniLibs
Write-Host "[4/4] Copy .so to plugin jniLibs..." -ForegroundColor Green
New-Item -ItemType Directory -Force -Path $PluginJniLibs | Out-Null
$SdkLibDir = Join-Path $MnnSdkDir "libs/$Abi"
$SdkIncludeDir = Join-Path $MnnSdkDir "include"
$SdkLlmIncludeDir = Join-Path $MnnSdkDir "transformers/llm/include"
New-Item -ItemType Directory -Force -Path $SdkLibDir | Out-Null
New-Item -ItemType Directory -Force -Path $SdkIncludeDir | Out-Null
New-Item -ItemType Directory -Force -Path $SdkLlmIncludeDir | Out-Null

foreach ($lib in $required) {
    Copy-Item -Force (Join-Path $BuildDir $lib) $PluginJniLibs
    Copy-Item -Force (Join-Path $BuildDir $lib) $SdkLibDir
    Write-Host "  OK $lib -> $PluginJniLibs" -ForegroundColor Green
}

# Copy NDK c++_shared
$NdkLibCpp = Join-Path $NdkPath "toolchains/llvm/prebuilt/windows-x86_64/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so"
if (Test-Path $NdkLibCpp) {
    Copy-Item -Force $NdkLibCpp $PluginJniLibs
    Copy-Item -Force $NdkLibCpp $SdkLibDir
    Write-Host "  OK libc++_shared.so -> $PluginJniLibs" -ForegroundColor Green
} else {
    Write-Host "  WARN libc++_shared.so not auto-copied, copy manually from NDK dir" -ForegroundColor Yellow
}

Copy-Item -Recurse -Force (Join-Path $MnnDir "include/*") $SdkIncludeDir
Copy-Item -Recurse -Force (Join-Path $MnnDir "transformers/llm/engine/include/*") $SdkLlmIncludeDir
Write-Host "  OK exported MNN headers -> $MnnSdkDir" -ForegroundColor Green

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host " Phase 2 complete - Android MNN .so ready!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Output: $PluginJniLibs" -ForegroundColor Cyan
Write-Host "MNN SDK: $MnnSdkDir" -ForegroundColor Cyan
Write-Host "Gradle can now use MNN_ROOT=$MnnSdkDir" -ForegroundColor Cyan
