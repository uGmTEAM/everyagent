param(
  [string]$QqDeb = "",
  [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$pkg = Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json
$version = $pkg.version
if (-not $OutDir) { $OutDir = Join-Path $root "dist" }
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

$stageRoot = Join-Path $OutDir "_stage"
$stage = Join-Path $stageRoot "ai-qq-bridge-$version"
if (Test-Path $stageRoot) { Remove-Item $stageRoot -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

$items = @("src", "loader", "scripts", "docker", "package.json", "README.md", "config.example.json", "install.sh", "uninstall.sh")
foreach ($item in $items) {
  $src = Join-Path $root $item
  if (-not (Test-Path $src)) { throw "missing: $item" }
  Copy-Item -Path $src -Destination $stage -Recurse -Force
}
Set-Content -Path (Join-Path $stage "VERSION") -Value $version -Encoding ascii

if ($QqDeb) {
  if (-not (Test-Path $QqDeb)) { throw "QQ deb not found: $QqDeb" }
  $vendor = Join-Path $stage "vendor"
  New-Item -ItemType Directory -Path $vendor -Force | Out-Null
  Copy-Item -Path $QqDeb -Destination (Join-Path $vendor "qq.deb")
}

$tarName = "ai-qq-bridge-$version-linux.tar.gz"
$tarPath = Join-Path $OutDir $tarName
if (Test-Path $tarPath) { Remove-Item $tarPath -Force }

# Build inside a container so executable bits are preserved.
$prev = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& docker run --rm -v "${stageRoot}:/stage" ubuntu:22.04 bash -c "cp -a /stage/ai-qq-bridge-$version /tmp/ && chmod -R u=rwX,go=rX /tmp/ai-qq-bridge-$version && find /tmp/ai-qq-bridge-$version -type f -exec chmod 644 {} + && chmod 755 /tmp/ai-qq-bridge-$version/install.sh /tmp/ai-qq-bridge-$version/uninstall.sh /tmp/ai-qq-bridge-$version/docker/*.sh && tar -czf /stage/$tarName -C /tmp ai-qq-bridge-$version"
$code = $LASTEXITCODE
$ErrorActionPreference = $prev
if ($code -ne 0) { throw "docker tar failed (exit $code)" }

$built = Join-Path $stageRoot $tarName
if (-not (Test-Path $built)) { throw "tarball not generated: $built" }
Move-Item -Path $built -Destination $tarPath -Force
Remove-Item $stageRoot -Recurse -Force

$hash = (Get-FileHash $tarPath -Algorithm SHA256).Hash.ToLower()
$size = [math]::Round((Get-Item $tarPath).Length / 1KB, 1)

Write-Output "package : $tarPath"
Write-Output "size    : $size KB"
Write-Output "sha256  : $hash"
Write-Output ""
Write-Output "install into container:"
Write-Output "  docker cp `"$tarPath`" <container>:/tmp/"
Write-Output "  docker exec -it <container> bash -c `"cd /tmp && tar xzf $tarName && ./ai-qq-bridge-$version/install.sh --data /data`""
Write-Output "  docker exec -it <container> aiqq-run"
