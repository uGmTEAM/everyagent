$ErrorActionPreference = 'Stop'

Set-Location (Join-Path $PSScriptRoot '..\backend')

if (-not (Test-Path 'node_modules')) {
    Write-Output '安装后端依赖...'
    npm install --no-audit --no-fund
}

Write-Output '启动后端。面板 http://127.0.0.1:7843 ，代理 http://0.0.0.0:7842'
node src/server.js
