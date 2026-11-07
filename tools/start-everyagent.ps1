# EveryAgent 快捷启动：必要时拉起 Docker Desktop，隐藏启动后端，等待面板就绪后打开浏览器。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools\start-everyagent.ps1 [-NoBrowser] [-SkipDockerWait]
[CmdletBinding()]
param(
    [int]$PanelPort = 0,
    [switch]$NoBrowser,
    [switch]$SkipDockerWait
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root 'data\logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir 'launcher.log'

function Write-LaunchLog([string]$message) {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
    Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

if ($PanelPort -le 0) {
    $PanelPort = 7843
    if ($env:EA_PANEL_PORT) {
        try { $PanelPort = [int]$env:EA_PANEL_PORT } catch { }
    }
}

function Test-Panel {
    try {
        Invoke-WebRequest -Uri ('http://127.0.0.1:{0}/' -f $PanelPort) -UseBasicParsing -TimeoutSec 2 | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Test-Docker {
    $docker = Get-Command docker -ErrorAction SilentlyContinue
    if (-not $docker) { return $false }
    try {
        $osType = & $docker.Source info --format '{{.OSType}}' 2>$null
        return ($LASTEXITCODE -eq 0 -and "$osType".Trim() -eq 'linux')
    } catch {
        return $false
    }
}

Write-LaunchLog '开始快捷启动'

if (Test-Panel) {
    Write-LaunchLog ('面板已在运行：http://127.0.0.1:{0}' -f $PanelPort)
    if (-not $NoBrowser) {
        Start-Process ('http://127.0.0.1:{0}' -f $PanelPort)
    }
    exit 0
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-LaunchLog '未找到 Node.js，请先安装 Node.js 24 LTS'
    exit 1
}

if (-not $SkipDockerWait -and -not (Test-Docker)) {
    $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if (-not (Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $desktop)) {
        Write-LaunchLog 'Docker Desktop 未运行，正在启动'
        Start-Process -FilePath $desktop
    }
    for ($i = 0; $i -lt 18; $i++) {
        Start-Sleep -Seconds 5
        if (Test-Docker) { break }
    }
    if (Test-Docker) {
        Write-LaunchLog 'Docker 已就绪'
    } else {
        Write-LaunchLog '等待 Docker 超时，继续启动后端（AI 容器可能暂时不可用）'
    }
}

$stdout = Join-Path $logDir 'backend.out.log'
$stderr = Join-Path $logDir 'backend.err.log'
$shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $shell)) {
    $found = Get-Command powershell.exe -ErrorAction SilentlyContinue
    if (-not $found) {
        Write-LaunchLog '未找到 powershell.exe，无法启动后端'
        exit 1
    }
    $shell = $found.Source
}

$backendScript = Join-Path $PSScriptRoot 'run-backend.ps1'
$arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $backendScript
Write-LaunchLog '启动后端（隐藏窗口）'
$process = Start-Process -FilePath $shell -ArgumentList $arguments -WorkingDirectory $root `
    -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
Write-LaunchLog ('后端进程已拉起：pid={0}' -f $process.Id)

$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    if (Test-Panel) { $ready = $true; break }
    Start-Sleep -Seconds 1
}

if ($ready) {
    Write-LaunchLog ('后台就绪：http://127.0.0.1:{0}' -f $PanelPort)
    if (-not $NoBrowser) {
        Start-Process ('http://127.0.0.1:{0}' -f $PanelPort)
    }
} else {
    Write-LaunchLog '等待面板超时，请查看 data\logs\backend.err.log'
    exit 1
}
