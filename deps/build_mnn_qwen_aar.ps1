param(
    [string]$HBuilderXRoot = "D:\Users\32530\Downloads\HBuilderX.5.07.2026041006\HBuilderX"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$androidRoot = Join-Path $PSScriptRoot "mnn-qwen-android-plugin"
$distributionAndroidRoot = Join-Path $repoRoot "frontend\nativeplugins\MnnQwenPlugin\android"
$buildRoot = Join-Path $PSScriptRoot "mnn-qwen-aar-build"
$outputDir = Join-Path $distributionAndroidRoot "libs"
$outputAar = Join-Path $outputDir "MnnQwenPlugin.aar"

$javac = Join-Path $HBuilderXRoot "plugins\amazon-corretto\bin\javac.exe"
$jar = Join-Path $HBuilderXRoot "plugins\amazon-corretto\bin\jar.exe"
if (-not (Test-Path -LiteralPath $javac) -or -not (Test-Path -LiteralPath $jar)) {
    throw "HBuilderX JDK not found under $HBuilderXRoot. Pass -HBuilderXRoot explicitly."
}

$resolvedBuildRoot = [IO.Path]::GetFullPath($buildRoot)
$resolvedDepsRoot = [IO.Path]::GetFullPath($PSScriptRoot)
if (-not $resolvedBuildRoot.StartsWith($resolvedDepsRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean build directory outside deps: $resolvedBuildRoot"
}
if (Test-Path -LiteralPath $resolvedBuildRoot) {
    Remove-Item -LiteralPath $resolvedBuildRoot -Recurse -Force
}

$stubClasses = Join-Path $buildRoot "stub-classes"
$pluginClasses = Join-Path $buildRoot "plugin-classes"
$aarRoot = Join-Path $buildRoot "aar"
$stubJar = Join-Path $buildRoot "compile-stubs.jar"
$classesJar = Join-Path $aarRoot "classes.jar"
New-Item -ItemType Directory -Force -Path $stubClasses, $pluginClasses, $aarRoot, $outputDir | Out-Null

$manualStubSources = Get-ChildItem -LiteralPath (Join-Path $androidRoot "manual-stubs\src") -Recurse -Filter *.java -File
$dcloudStubSources = Get-ChildItem -LiteralPath (Join-Path $androidRoot "dcloud-stubs\src\main\java") -Recurse -Filter *.java -File
$stubSources = @($manualStubSources.FullName) + @($dcloudStubSources.FullName)
if ($stubSources.Count -eq 0) {
    throw "No compile stub sources found"
}

Write-Host "[1/4] Compiling Android and DCloud ABI stubs..."
& $javac -encoding UTF-8 -source 11 -target 11 -d $stubClasses $stubSources
if ($LASTEXITCODE -ne 0) { throw "Stub compilation failed" }
& $jar --create --file $stubJar -C $stubClasses .
if ($LASTEXITCODE -ne 0) { throw "Stub JAR creation failed" }

$moduleSources = Get-ChildItem -LiteralPath (Join-Path $androidRoot "src\main\java") -Recurse -Filter *.java -File
Write-Host "[2/4] Compiling MnnQwenModule..."
& $javac -encoding UTF-8 -source 11 -target 11 -classpath $stubJar -d $pluginClasses $moduleSources.FullName
if ($LASTEXITCODE -ne 0) { throw "Plugin Java compilation failed" }
& $jar --create --file $classesJar -C $pluginClasses .
if ($LASTEXITCODE -ne 0) { throw "Plugin classes.jar creation failed" }

Write-Host "[3/4] Staging AAR assets and native libraries..."
Copy-Item -LiteralPath (Join-Path $androidRoot "src\main\AndroidManifest.xml") -Destination (Join-Path $aarRoot "AndroidManifest.xml")
Copy-Item -LiteralPath (Join-Path $androidRoot "src\main\assets") -Destination (Join-Path $aarRoot "assets") -Recurse

$jniTarget = Join-Path $aarRoot "jni\arm64-v8a"
New-Item -ItemType Directory -Force -Path $jniTarget | Out-Null
$jniSource = Join-Path $androidRoot "src\main\jniLibs\arm64-v8a"
foreach ($library in @("libMNN.so", "libmnn_qwen_jni.so", "libc++_shared.so")) {
    $source = Join-Path $jniSource $library
    if (-not (Test-Path -LiteralPath $source)) { throw "Missing native library: $source" }
    Copy-Item -LiteralPath $source -Destination (Join-Path $jniTarget $library)
}
Set-Content -LiteralPath (Join-Path $aarRoot "R.txt") -Value "" -Encoding Ascii
Set-Content -LiteralPath (Join-Path $aarRoot "proguard.txt") -Value "" -Encoding Ascii

Write-Host "[4/4] Creating MnnQwenPlugin.aar..."
if (Test-Path -LiteralPath $outputAar) {
    Remove-Item -LiteralPath $outputAar -Force
}
& $jar --create --file $outputAar -C $aarRoot .
if ($LASTEXITCODE -ne 0) { throw "AAR creation failed" }

$aarInfo = Get-Item -LiteralPath $outputAar
Write-Host "AAR ready: $($aarInfo.FullName)"
Write-Host "Size: $([math]::Round($aarInfo.Length / 1MB, 2)) MB"
