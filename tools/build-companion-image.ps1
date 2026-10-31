# Build the companion image (ea-companion:latest).
# Based on ea-agent:latest (research runtime + Xvfb/XFCE/noVNC), plus QQ NT and ai-qq-bridge.
# Build context must be the repository root.
param(
    [string]$BaseImage = "ea-agent:latest",
    [string]$Tag = "ea-companion:latest",
    [string]$QqDebUrl = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Output "Checking Docker..."
docker version --format 'Server={{.ServerVersion}}' | Out-Null

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
