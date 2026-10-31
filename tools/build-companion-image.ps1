# Build the companion image (ea-companion:latest).
# Based on ea-agent:latest (research runtime + Xvfb/XFCE/noVNC), plus QQ NT and ai-qq-bridge.
# Build context must be the repository root.
# ai-qq-bridge lives in its own repository (https://github.com/uGmTEAM/ai-qq-bridge):
# the Dockerfile COPYs ai-qq-bridge/, so fetch it when the folder is missing.
param(
    [string]$BaseImage = "ea-agent:latest",
    [string]$Tag = "ea-companion:latest",
    [string]$QqDebUrl = "",
    [string]$BridgeRepo = "https://github.com/uGmTEAM/ai-qq-bridge.git",
    [string]$BridgeRef = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Output "Checking Docker..."
docker version --format 'Server={{.ServerVersion}}' | Out-Null

$bridgeDir = Join-Path $root 'ai-qq-bridge'
if (-not (Test-Path (Join-Path $bridgeDir 'package.json'))) {
    Write-Output "ai-qq-bridge not found, cloning $BridgeRepo ..."
    if (Test-Path $bridgeDir) { Remove-Item $bridgeDir -Recurse -Force }
    $cloneArgs = @('clone', '--depth', '1')
    if ($BridgeRef) { $cloneArgs += @('--branch', $BridgeRef) }
    $cloneArgs += @($BridgeRepo, $bridgeDir)
    & git @cloneArgs
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $bridgeDir 'package.json'))) {
        throw "Failed to fetch ai-qq-bridge from $BridgeRepo. Clone it into ai-qq-bridge/ at the repo root and retry."
    }
}

# Build ea-agent first when the base image is missing.
$images = docker images --format "{{.Repository}}:{{.Tag}}"
if ($images -notcontains $BaseImage) {
    Write-Output "Missing $BaseImage, building ea-agent first ..."
    & (Join-Path $PSScriptRoot 'build-images.ps1')
}

$buildArgs = @('build', '-f', 'companion-image/Dockerfile', '-t', $Tag, '--build-arg', "BASE_IMAGE=$BaseImage")
if ($QqDebUrl) {
    $buildArgs += @('--build-arg', "QQ_DEB_URL=$QqDebUrl")
}
$buildArgs += '.'

Write-Output "Building $Tag ..."
Push-Location $root
try {
    docker @buildArgs
} finally {
    Pop-Location
}

Write-Output "Done. Images:"
docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | Select-String 'ea-agent|ea-companion'
