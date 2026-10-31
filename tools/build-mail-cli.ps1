# 构建 mail-cli（Windows 侧执行）
# 在临时 Ubuntu 容器中安装 Go 并交叉/原生编译，产物复制到 release/，容器随后删除。
param(
    [string]$SourceDir = (Join-Path (Split-Path -Parent $PSScriptRoot) "mail-cli"),
    [string]$OutDir = (Join-Path (Split-Path -Parent $PSScriptRoot) "release"),
    [string]$BuilderImage = "ubuntu:24.04",
    [string]$ContainerName = "mailcli-builder"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $SourceDir)) { throw "源码目录不存在: $SourceDir" }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

$existing = docker ps -a --filter "name=^/$ContainerName$" --format "{{.Names}}"
if ($existing) { docker rm -f $ContainerName | Out-Null }

Write-Host "[1/4] 启动构建容器 $ContainerName ..."
docker run -d --name $ContainerName -v "${SourceDir}:/src" -w /src $BuilderImage sleep infinity | Out-Null

try {
    Write-Host "[2/4] 安装 Go 工具链（仅容器内）..."
    docker exec $ContainerName sh -lc "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends golang-go ca-certificates >/tmp/apt.log 2>&1"

    Write-Host "[3/4] 编译 linux/amd64 静态二进制..."
    docker exec -e GOFLAGS=-mod=mod -e GOPROXY=https://goproxy.cn,direct -e GOSUMDB=off -e CGO_ENABLED=0 `
        $ContainerName sh -lc "cd /src && mkdir -p bin && go build -trimpath -ldflags '-s -w' -o bin/mail . && ./bin/mail version"

    Write-Host "[4/4] 复制产物..."
    Copy-Item (Join-Path $SourceDir "bin\mail") (Join-Path $OutDir "mail-cli-linux-amd64") -Force
    Get-Item (Join-Path $OutDir "mail-cli-linux-amd64") | Select-Object FullName, Length | Format-List
}
finally {
    docker rm -f $ContainerName | Out-Null
}

Write-Host "完成：$OutDir\mail-cli-linux-amd64"
