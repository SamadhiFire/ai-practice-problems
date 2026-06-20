# stage_mnn_android_assets.ps1 - Copy verified MNN model files into the Android plugin assets directory
# Usage: .\stage_mnn_android_assets.ps1 [-ModelDir <path>] [-CleanTarget]

param(
    [string]$ModelDir = "",
    [switch]$CleanTarget
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$SourceModelDir = if ([string]::IsNullOrWhiteSpace($ModelDir)) {
    Join-Path $RepoRoot "models/qwen-mnn"
} else {
    $ModelDir
}
$TargetModelDir = Join-Path $ScriptDir "mnn-qwen-android-plugin/src/main/assets/models/qwen-mnn"

$RequiredFiles = @(
    "config.json",
    "llm_config.json",
    "llm.mnn",
    "llm.mnn.weight",
    "tokenizer.mtok"
)
$OptionalFiles = @(
    "embeddings_bf16.bin"
)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Stage Android model assets" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Source: $SourceModelDir" -ForegroundColor White
Write-Host " Target: $TargetModelDir" -ForegroundColor White
Write-Host ""

if (-not (Test-Path $SourceModelDir)) {
    throw "Model directory not found: $SourceModelDir"
}

$missing = @()
foreach ($file in $RequiredFiles) {
    $path = Join-Path $SourceModelDir $file
    if (-not (Test-Path $path)) {
        $missing += $file
    }
}

if ($missing.Count -gt 0) {
    throw "Required model files missing: $($missing -join ', ')"
}

$weightPath = Join-Path $SourceModelDir "llm.mnn.weight"
$weightSize = (Get-Item $weightPath).Length
if ($weightSize -lt 50MB) {
    throw "llm.mnn.weight looks too small ($([math]::Round($weightSize / 1MB, 2)) MB). Re-check your llmexport.py output before packaging."
}

if ($CleanTarget -and (Test-Path $TargetModelDir)) {
    Remove-Item -Recurse -Force $TargetModelDir
}

New-Item -ItemType Directory -Force -Path $TargetModelDir | Out-Null

foreach ($file in $RequiredFiles + $OptionalFiles) {
    $sourcePath = Join-Path $SourceModelDir $file
    if (-not (Test-Path $sourcePath)) {
        continue
    }
    Copy-Item -Force $sourcePath (Join-Path $TargetModelDir $file)
    $size = (Get-Item $sourcePath).Length
    Write-Host "  OK $file ($([math]::Round($size / 1MB, 2)) MB)" -ForegroundColor Green
}

$manifestPath = Join-Path $TargetModelDir "asset-manifest.json"
$manifest = [ordered]@{
    generatedAt = (Get-Date).ToString("s")
    sourceModelDir = (Resolve-Path $SourceModelDir).Path
    requiredFiles = $RequiredFiles
    optionalFiles = @($OptionalFiles | Where-Object { Test-Path (Join-Path $SourceModelDir $_) })
    stagedFiles = @(
        Get-ChildItem -Path $TargetModelDir -File |
            Where-Object { $_.Name -ne "asset-manifest.json" } |
            Sort-Object Name |
            ForEach-Object {
                [ordered]@{
                    name = $_.Name
                    sizeBytes = $_.Length
                }
            }
    )
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -Path $manifestPath -Encoding UTF8

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host " Android model assets are ready" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host "Output: $TargetModelDir" -ForegroundColor Cyan
