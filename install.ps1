# EveryAgent 安装脚本（Windows）
#
# 完成：环境检查（缺失的 Node.js / WSL2 / Docker Desktop 会自动安装）→ 安装后端依赖 → 构建 Docker 镜像 → 创建开机自启快捷方式（后台启动平台服务）。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Check             只做环境检查，不做任何改动
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -NoAutoInstall     不自动安装系统依赖，只检查并提示
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -SkipDocker        跳过 Docker 检查与镜像构建（沙盒/无 Docker 环境）
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -SkipImages        跳过镜像构建（镜像已准备好时）
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -ForceImages       强制重建两个镜像
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -NoAutostart       不创建开机自启快捷方式
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -OpenPanelOnStartup 登录后同时打开面板
#
# 自动安装系统依赖需要管理员权限：当前不是管理员时会弹出 UAC 并在新窗口继续。
# Windows Sandbox 不支持嵌套虚拟化，WSL2 与 Docker Desktop 无法运行；沙盒内请用 -SkipDocker 只验证面板安装。
# 端口可用环境变量覆盖：EA_PANEL_PORT（默认 7843）、EA_PORT（默认 7842）。

[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$NoAutoInstall,
    [switch]$SkipDocker,
    [switch]$SkipImages,
    [switch]$ForceImages,
    [switch]$NoAutostart,
    [switch]$OpenPanelOnStartup
)

$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$backendDir = Join-Path $root 'backend'
$logDir = Join-Path $root 'data\logs'
$script:errors = 0
$autoInstall = (-not $Check) -and (-not $NoAutoInstall)
$needInstall = New-Object System.Collections.ArrayList

function Write-Step([string]$text) {
    Write-Host ''
    Write-Host ('== ' + $text + ' ==') -ForegroundColor Cyan
}

function Write-Ok([string]$text) {
    Write-Host ('[ OK ] ' + $text) -ForegroundColor Green
}

function Write-Warn([string]$text) {
    Write-Host ('[WARN] ' + $text) -ForegroundColor Yellow
}

function Write-Fail([string]$text) {
    Write-Host ('[FAIL] ' + $text) -ForegroundColor Red
    $script:errors++
}

function Test-DockerLinux {
    $docker = Get-Command docker -ErrorAction SilentlyContinue
    if (-not $docker) { return $false }
    try {
        $osType = & $docker.Source info --format '{{.OSType}}' 2>&1
        if ($LASTEXITCODE -ne 0) { return $false }
        return ("$osType".Trim() -eq 'linux')
    } catch {
        return $false
    }
}

function Test-Image([string]$name) {
    & docker image inspect $name *> $null
    return ($LASTEXITCODE -eq 0)
}

function Test-PortInUse([int]$port) {
    try {
        $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
        return [bool]$conn
    } catch {
        return $false
    }
}

function Get-NodeInfo {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { return $null }
    try {
        $version = "$(& node -p 'process.versions.node' 2>$null)".Trim()
        $parts = $version.Split('.')
        if ($parts.Count -lt 2) { return $null }
        return [pscustomobject]@{ Version = $version; Major = [int]$parts[0]; Minor = [int]$parts[1] }
    } catch {
        return $null
    }
}

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-WslReady {
    $wsl = Get-Command wsl -ErrorAction SilentlyContinue
    if (-not $wsl) { return $false }
    try {
        & wsl --status *> $null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

function Test-WindowsSandbox {
    # Windows Sandbox 的内置账户固定为 WDAGUtilityAccount，且不支持嵌套虚拟化。
    return ($env:USERNAME -eq 'WDAGUtilityAccount')
}

function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @()
    if ($machine) { $parts += $machine }
    if ($user) { $parts += $user }
    if ($parts.Count -gt 0) { $env:Path = ($parts -join ';') }
}

function Install-WithWinget([string]$id, [string]$name) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) { return $false }
    Write-Host ('正在通过 winget 安装 ' + $name + ' ...')
    & $winget.Source install --id $id -e --silent --accept-source-agreements --accept-package-agreements
    return ($LASTEXITCODE -eq 0)
}

function Install-NodeJs {
    if (Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js LTS') { return $true }
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Write-Host 'winget 不可用，改为下载 Node.js 官方安装包 ...'
        $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing -TimeoutSec 30
        $release = $index | Where-Object { $_.version -like 'v24.*' } | Select-Object -First 1
        if (-not $release) { $release = $index | Where-Object { $_.lts } | Select-Object -First 1 }
        if (-not $release) { throw '无法获取 Node.js 版本列表' }
        $url = 'https://nodejs.org/dist/' + $release.version + '/node-' + $release.version + '-x64.msi'
        $msi = Join-Path $env:TEMP ('node-' + $release.version + '-x64.msi')
        Write-Host ('下载 ' + $url)
        Invoke-WebRequest -Uri $url -OutFile $msi -UseBasicParsing -TimeoutSec 900
        $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', ('"' + $msi + '"'), '/qn', '/norestart') -PassThru -Wait
        return ($process.ExitCode -eq 0 -or $process.ExitCode -eq 3010)
    } catch {
        Write-Host ('Node.js 自动安装失败：' + $_.Exception.Message) -ForegroundColor Red
        return $false
    }
}

function Install-Wsl2 {
    Write-Host '正在启用 WSL2（wsl --install --no-distribution）...'
    try {
        & wsl --install --no-distribution
        return ($LASTEXITCODE -eq 0)
    } catch {
        Write-Host ('WSL2 自动启用失败：' + $_.Exception.Message) -ForegroundColor Red
        return $false
    }
}

function Install-DockerDesktop {
    if (Install-WithWinget 'Docker.DockerDesktop' 'Docker Desktop') { return $true }
    try {
        Write-Host 'winget 不可用，改为下载 Docker Desktop 官方安装包 ...'
        $installer = Join-Path $env:TEMP 'DockerDesktopInstaller.exe'
        Invoke-WebRequest -Uri 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe' -OutFile $installer -UseBasicParsing -TimeoutSec 1800
        $process = Start-Process -FilePath $installer -ArgumentList @('install', '--quiet', '--accept-license') -PassThru -Wait
        return ($process.ExitCode -eq 0)
    } catch {
        Write-Host ('Docker Desktop 自动安装失败：' + $_.Exception.Message) -ForegroundColor Red
        return $false
    }
}

function Restart-Elevated {
    $shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $shell)) {
        $shell = (Get-Command powershell.exe -ErrorAction SilentlyContinue).Source
    }
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'))
    if ($SkipDocker) { $argList += '-SkipDocker' }
    if ($SkipImages) { $argList += '-SkipImages' }
    if ($ForceImages) { $argList += '-ForceImages' }
    if ($NoAutostart) { $argList += '-NoAutostart' }
    if ($OpenPanelOnStartup) { $argList += '-OpenPanelOnStartup' }
    Write-Host '安装系统依赖需要管理员权限，正在以管理员身份重新运行安装脚本 ...' -ForegroundColor Yellow
    try {
        Start-Process -FilePath $shell -ArgumentList $argList -WorkingDirectory $root -Verb RunAs
    } catch {
        Write-Host '提权被取消。请右键「以管理员身份运行」PowerShell 后重新执行 install.ps1。' -ForegroundColor Red
        exit 1
    }
}

$panelPort = 7843
if ($env:EA_PANEL_PORT) {
    try { $panelPort = [int]$env:EA_PANEL_PORT } catch { }
}
$proxyPort = 7842
if ($env:EA_PORT) {
    try { $proxyPort = [int]$env:EA_PORT } catch { }
}

Write-Host 'EveryAgent Windows 安装' -ForegroundColor White
Write-Host ('安装目录：' + $root)

Write-Step '检查安装目录'
$required = @(
    'backend\src\server.js',
    'agent-image\Dockerfile',
    'egress-proxy\Dockerfile',
    'memory-service\index.js',
    'agent-image\ollama-bin\ollama',
    'tools\start-everyagent.ps1',
    'tools\install-autostart.ps1'
)
foreach ($item in $required) {
    if (Test-Path -LiteralPath (Join-Path $root $item)) {
        Write-Ok $item
    } else {
        Write-Fail ('缺少 ' + $item + '（请在发行包根目录运行本脚本）')
    }
}

Write-Step '检查 Node.js'
$nodeInfo = Get-NodeInfo
$nodeReady = $false
if (-not $nodeInfo) {
    if ($autoInstall) {
        [void]$needInstall.Add('node')
        Write-Warn '未安装 Node.js，将自动安装 Node.js 24 LTS'
    } else {
        Write-Fail '未安装 Node.js。需要 Node.js 22.5+（推荐 24 LTS），见 https://nodejs.org/'
    }
} elseif ($nodeInfo.Major -gt 22 -or ($nodeInfo.Major -eq 22 -and $nodeInfo.Minor -ge 5)) {
    Write-Ok ('node ' + $nodeInfo.Version)
    $nodeReady = $true
    if ($nodeInfo.Major -lt 24) {
        Write-Warn ('推荐 Node.js 24 LTS，当前 ' + $nodeInfo.Version)
    }
} else {
    if ($autoInstall) {
        [void]$needInstall.Add('node')
        Write-Warn ('node 版本过低：' + $nodeInfo.Version + '，将自动升级到 Node.js 24 LTS')
    } else {
        Write-Fail ('node 版本过低：' + $nodeInfo.Version + '，需要 22.5+（推荐 24 LTS）')
    }
}
$npm = Get-Command npm -ErrorAction SilentlyContinue
if ($npm) {
    Write-Ok ('npm ' + (& npm --version))
} elseif ($nodeReady) {
    Write-Fail '未安装 npm（通常随 Node.js 一起安装）'
} else {
    Write-Warn 'npm 随 Node.js 一起安装'
}

Write-Step '检查 WSL2'
if ($SkipDocker) {
    Write-Warn '已指定 -SkipDocker，跳过 WSL2 检查'
} else {
    $wslReady = Test-WslReady
    if ($wslReady) {
        Write-Ok 'WSL2 已就绪'
    } elseif (Test-WindowsSandbox) {
        Write-Warn 'Windows Sandbox 不支持嵌套虚拟化，WSL2 无法运行'
    } elseif ($autoInstall) {
        [void]$needInstall.Add('wsl')
        Write-Warn 'WSL2 未就绪，将自动执行 wsl --install（安装后可能需要重启 Windows）'
    } else {
        Write-Warn 'WSL2 未就绪：Docker Desktop 需要 WSL2，请手动启用（wsl --install）'
    }
}

Write-Step '检查 Docker'
if ($SkipDocker) {
    Write-Warn '已指定 -SkipDocker，跳过 Docker 检查（AI 容器无法运行，仅面板可用）'
} elseif (Test-WindowsSandbox) {
    Write-Warn '检测到 Windows Sandbox：不支持嵌套虚拟化，Docker Desktop 与 WSL2 无法运行。'
    Write-Warn '沙盒内请使用 install.bat -SkipDocker 只验证面板安装；完整功能请在宿主机安装。'
    Write-Fail 'Windows Sandbox 无法运行 Docker Desktop'
} else {
    $docker = Get-Command docker -ErrorAction SilentlyContinue
    if (-not $docker) {
        if ($autoInstall) {
            [void]$needInstall.Add('docker')
            Write-Warn '未安装 Docker Desktop，将自动安装'
        } else {
            Write-Fail '未安装 Docker Desktop，见 https://www.docker.com/products/docker-desktop/'
        }
    } else {
        Write-Ok ('docker ' + (& docker --version))
        if (-not (Test-DockerLinux)) {
            if (-not $Check) {
                $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
                if (Test-Path -LiteralPath $desktop) {
                    Write-Warn 'Docker 未就绪，正在启动 Docker Desktop 并等待 ...'
                    try {
                        Start-Process -FilePath $desktop
                    } catch {
                        Write-Warn ('无法启动 Docker Desktop：' + $_.Exception.Message)
                    }
                    for ($i = 0; $i -lt 18; $i++) {
                        Start-Sleep -Seconds 5
                        if (Test-DockerLinux) { break }
                    }
                }
            }
            if (Test-DockerLinux) {
                Write-Ok 'Docker 守护进程可用（Linux 容器）'
            } else {
                Write-Fail '无法连接 Docker（或不是 Linux 容器模式）：请确认 Docker Desktop 已启动、WSL2 已就绪'
            }
        } else {
            Write-Ok 'Docker 守护进程可用（Linux 容器）'
        }
    }
}

Write-Step '检查磁盘与内存'
$freeGb = $null
try {
    $driveName = (Get-Item -LiteralPath $root).PSDrive.Name
    $drive = Get-PSDrive -Name $driveName -ErrorAction SilentlyContinue
    if ($drive -and $drive.Free) {
        $freeGb = [math]::Round($drive.Free / 1GB, 1)
    }
} catch { }
if ($null -eq $freeGb) {
    Write-Warn '无法读取安装盘剩余空间'
} elseif ($freeGb -ge 10) {
    Write-Ok ('安装盘剩余 ' + $freeGb + ' GB')
} else {
    Write-Fail ('安装盘剩余 ' + $freeGb + ' GB，建议至少 10 GB（镜像约 4 GB，各 AI 工作区另计）')
}
try {
    $memGb = [math]::Round((Get-CimInstance -ClassName Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
    if ($memGb -ge 8) {
        Write-Ok ('内存 ' + $memGb + ' GB')
    } else {
        Write-Warn ('内存 ' + $memGb + ' GB 偏小：建议 16 GB 以上')
    }
} catch {
    Write-Warn '无法读取物理内存'
}

Write-Step '检查端口'
foreach ($port in @($proxyPort, $panelPort)) {
    if (Test-PortInUse $port) {
        Write-Warn ('端口 ' + $port + ' 已被占用，后端可能无法启动（若是旧实例可先停止）')
    } else {
        Write-Ok ('端口 ' + $port + ' 空闲')
    }
}

if ($needInstall.Count -gt 0) {
    Write-Step '自动补充依赖'
    if (-not (Test-Admin)) {
        Restart-Elevated
        exit 0
    }

    if ($needInstall -contains 'node') {
        Write-Host '安装 Node.js 24 LTS ...'
        if (-not (Install-NodeJs)) {
            Write-Fail 'Node.js 自动安装失败，请手动安装：https://nodejs.org/'
        } else {
            Update-SessionPath
            $nodeInfo = Get-NodeInfo
            if ($nodeInfo -and ($nodeInfo.Major -gt 22 -or ($nodeInfo.Major -eq 22 -and $nodeInfo.Minor -ge 5))) {
                Write-Ok ('node ' + $nodeInfo.Version)
            } else {
                Write-Warn 'Node.js 已安装，但当前会话尚未识别，请重新打开终端后重试'
            }
            $npm = Get-Command npm -ErrorAction SilentlyContinue
            if ($npm) {
                Write-Ok ('npm ' + (& npm --version))
            } else {
                Write-Warn 'npm 未在当前会话生效，重新打开终端后重试'
            }
        }
    }

    $wslNeedsReboot = $false
    if ($needInstall -contains 'wsl') {
        if (Install-Wsl2) {
            Update-SessionPath
            if (Test-WslReady) {
                Write-Ok 'WSL2 已启用'
            } else {
                $wslNeedsReboot = $true
                Write-Warn 'WSL2 已提交安装，需要重启 Windows 后重新运行 install.ps1'
            }
        } else {
            Write-Fail 'WSL2 自动启用失败，请以管理员身份执行 wsl --install'
        }
    }

    if ($needInstall -contains 'docker') {
        if ($wslNeedsReboot) {
            Write-Warn 'Docker Desktop 依赖 WSL2，重启后再重新运行 install.ps1 完成安装'
        } else {
            Write-Host '安装 Docker Desktop ...'
            if (-not (Install-DockerDesktop)) {
                Write-Fail 'Docker Desktop 自动安装失败，请手动安装：https://www.docker.com/products/docker-desktop/'
            } else {
                Update-SessionPath
                $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
                if ((Test-Path -LiteralPath $desktop) -and -not (Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue)) {
                    Write-Host '启动 Docker Desktop 并等待就绪 ...'
                    try { Start-Process -FilePath $desktop } catch { }
                }
                for ($i = 0; $i -lt 18; $i++) {
                    Start-Sleep -Seconds 5
                    if (Test-DockerLinux) { break }
                }
                if (Test-DockerLinux) {
                    Write-Ok 'Docker 守护进程可用（Linux 容器）'
                } else {
                    Write-Warn 'Docker Desktop 已安装，但尚未就绪：请按提示完成首次启动（可能需重启或注销），然后重新运行 install.ps1'
                }
            }
        }
    }

    if ($wslNeedsReboot) {
        Write-Host ''
        Write-Host '依赖安装未完成：请重启 Windows 后重新运行 install.ps1。' -ForegroundColor Yellow
        exit 1
    }
}

if ($script:errors -gt 0) {
    Write-Host ''
    Write-Host ('环境检查未通过（' + $script:errors + ' 项），请先解决上面的问题再安装。') -ForegroundColor Red
    exit 1
}

if ($Check) {
    Write-Host ''
    Write-Ok '环境检查完成（-Check 模式，未做任何改动）'
    exit 0
}

Write-Step '安装后端依赖'
if (-not (Test-Path -LiteralPath (Join-Path $backendDir 'node_modules'))) {
    Push-Location -LiteralPath $backendDir
    try {
        & npm install --omit=dev --no-audit --no-fund
        $npmExit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($npmExit -ne 0) {
        Write-Host 'npm install 失败，请检查网络或 npm 源配置' -ForegroundColor Red
        exit 1
    }
    Write-Ok 'backend\node_modules 已就绪'
} else {
    Write-Ok 'backend\node_modules 已存在（如需更新依赖请删除后重跑）'
}

if ($SkipDocker) {
    Write-Step '跳过镜像构建'
    Write-Warn '已指定 -SkipDocker，未构建或检查 ea-egress / ea-agent 镜像（AI 容器无法运行）'
} elseif ($SkipImages) {
    Write-Step '跳过镜像构建'
    foreach ($image in @('ea-agent:latest', 'ea-egress:latest')) {
        if (Test-Image $image) {
            Write-Ok $image
        } else {
            Write-Fail ('镜像 ' + $image + ' 不存在（去掉 -SkipImages 重新运行，或先构建）')
        }
    }
    if ($script:errors -gt 0) { exit 1 }
} else {
    Write-Step '构建 Docker 镜像（首次需下载数 GB，耗时较长）'

    if (-not $ForceImages -and (Test-Image 'ea-egress:latest')) {
        Write-Ok 'ea-egress:latest 已存在（跳过；用 -ForceImages 强制重建）'
    } else {
        Write-Host '构建 ea-egress:latest ...'
        & docker build -t ea-egress:latest (Join-Path $root 'egress-proxy')
        if ($LASTEXITCODE -ne 0) {
            Write-Host 'ea-egress 构建失败' -ForegroundColor Red
            exit 1
        }
        Write-Ok 'ea-egress:latest'
    }

    if (-not $ForceImages -and (Test-Image 'ea-agent:latest')) {
        Write-Ok 'ea-agent:latest 已存在（跳过；用 -ForceImages 强制重建）'
    } else {
        Write-Host '构建 ea-agent:latest（需要联网下载 Node、apt 包与 ollama 模型）...'
        & docker build -t ea-agent:latest (Join-Path $root 'agent-image')
        if ($LASTEXITCODE -ne 0) {
            Write-Host 'ea-agent 构建失败。常见原因：网络不稳定、Docker 磁盘不足；可配置镜像加速后重试。' -ForegroundColor Red
            exit 1
        }
        Write-Ok 'ea-agent:latest'
    }
}

Write-Step '准备数据目录'
New-Item -ItemType Directory -Path (Join-Path $root 'data') -Force | Out-Null
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
Write-Ok (Join-Path $root 'data')

Write-Step '创建开机自启快捷方式'
if ($NoAutostart) {
    Write-Warn '已指定 -NoAutostart，跳过快捷方式创建'
} else {
    $autostartScript = Join-Path $root 'tools\install-autostart.ps1'
    $shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $shell)) {
        $shell = (Get-Command powershell.exe -ErrorAction SilentlyContinue).Source
    }
    $autostartArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $autostartScript)
    if ($OpenPanelOnStartup) { $autostartArgs += '-OpenPanelOnStartup' }
    & $shell @autostartArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Warn '快捷方式创建失败，可稍后手动运行 tools\install-autostart.ps1'
    }
}

$lanIp = $null
try {
    $lanIp = (Get-NetIPConfiguration -ErrorAction Stop |
        Where-Object { $_.IPv4DefaultGateway -and $_.IPv4Address } |
        Select-Object -First 1).IPv4Address.IPAddress
} catch { }
if (-not $lanIp) {
    try {
        $lanIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
            Select-Object -First 1).IPAddress
    } catch { }
}

Write-Step '安装完成'
if ($SkipDocker) {
    Write-Warn '当前为无 Docker 模式：面板可以启动，但 AI 容器无法运行。'
}
Write-Host ('  面板（管理后台）： http://127.0.0.1:' + $panelPort)
if ($lanIp) {
    Write-Host ('  局域网访问：       http://' + $lanIp + ':' + $panelPort)
}
Write-Host ('  AI 代理/接口：     http://127.0.0.1:' + $proxyPort + '  （端口 ' + $proxyPort + ' 需要开放给容器出网代理）')
Write-Host ('  数据目录：         ' + (Join-Path $root 'data'))
Write-Host ('  日志目录：         ' + $logDir)
Write-Host ''
Write-Host '启动方式：'
if ($NoAutostart) {
    Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File tools\start-everyagent.ps1'
} else {
    if ($OpenPanelOnStartup) {
        Write-Host '  已加入 Windows 启动栏：下次登录自动在后台启动并打开面板。'
    } else {
        Write-Host '  已加入 Windows 启动栏：下次登录自动在后台启动。'
    }
    Write-Host '  现在启动：powershell -NoProfile -ExecutionPolicy Bypass -File tools\start-everyagent.ps1'
    Write-Host '  移除自启：powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Remove'
}
Write-Host ''
Write-Host '下一步：'
Write-Host '  1. 打开面板 → 供应商，填写 OpenAI 兼容接口（如 DeepSeek https://api.deepseek.com）与 API Key。'
Write-Host '  2. 在「Judge / 模型」里选择判定模型。'
Write-Host '  3. 新建 AI：填写研究目标、人格（可选）、平台规则。'
Write-Host ''
Write-Warn '面板与 7842 端口默认监听 0.0.0.0 且无鉴权：不要直接暴露到公网，请用防火墙或带认证的反向代理。'
