$ErrorActionPreference = 'Continue'

Write-Output '=== Node ==='
try { node --version } catch { Write-Output 'node 未安装' }
try { npm --version } catch { Write-Output 'npm 未安装' }

Write-Output ''
Write-Output '=== Docker ==='
try {
    docker --version
    docker info --format 'Server={{.ServerVersion}} OS={{.OSType}} CPU={{.NCPU}} Mem={{.MemTotal}}'
} catch {
    Write-Output 'Docker 未安装或未启动'
}

Write-Output ''
Write-Output '=== WSL ==='
try {
    wsl --status
} catch {
    Write-Output 'WSL 未启用'
}

Write-Output ''
Write-Output '=== 磁盘 ==='
Get-PSDrive -Name C, G | Select-Object Name, Used, Free

Write-Output ''
Write-Output '=== 端口 ==='
$ports = Get-NetTCPConnection -LocalPort 7842, 7843 -ErrorAction SilentlyContinue
if ($ports) {
    $ports | Select-Object LocalAddress, LocalPort, State, OwningProcess
} else {
    Write-Output '7842 / 7843 空闲'
}

Write-Output ''
Write-Output '=== 镜像 ==='
try {
    docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | Select-String 'ea-agent|ea-egress'
} catch {
    Write-Output '无法查询镜像'
}
