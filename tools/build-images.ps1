$ErrorActionPreference = 'Stop'

Write-Output '检查 Docker...'
docker --version
docker info --format 'Server={{.ServerVersion}} OS={{.OSType}} CPU={{.NCPU}} Mem={{.MemTotal}}'

$root = Split-Path -Parent $PSScriptRoot

Write-Output ''
Write-Output '构建出网代理镜像 ea-egress:latest ...'
docker build -t ea-egress:latest (Join-Path $root 'egress-proxy')

Write-Output ''
Write-Output '构建 AI 镜像 ea-agent:latest ...'
docker build -t ea-agent:latest (Join-Path $root 'agent-image')

Write-Output ''
Write-Output '完成。镜像列表：'
docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | Select-String 'ea-agent|ea-egress'
