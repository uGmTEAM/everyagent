# 把 EveryAgent 快捷启动脚本放进 Windows「启动」文件夹，登录后自动在后台拉起平台。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-autostart.ps1
#       加 -OpenPanelOnStartup 登录后同时打开面板；-Remove 移除自启快捷方式。
[CmdletBinding()]
param(
    [switch]$Remove,
    [switch]$OpenPanelOnStartup,
    [string]$ShortcutName = 'EveryAgent.lnk'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$startupDir = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupDir $ShortcutName

if ($Remove) {
    if (Test-Path -LiteralPath $shortcutPath) {
        Remove-Item -LiteralPath $shortcutPath -Force
        Write-Output ('已移除开机自启：' + $shortcutPath)
    } else {
        Write-Output ('未找到自启快捷方式：' + $shortcutPath)
    }
    exit 0
}

$launcher = Join-Path $PSScriptRoot 'start-everyagent.ps1'
if (-not (Test-Path -LiteralPath $launcher)) {
    throw '缺少 tools\start-everyagent.ps1，无法创建自启快捷方式'
}

$arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $launcher
if (-not $OpenPanelOnStartup) {
    $arguments += ' -NoBrowser'
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shortcut.Arguments = $arguments
$shortcut.WorkingDirectory = $root
$shortcut.WindowStyle = 7
$shortcut.Description = 'EveryAgent 平台快捷启动（登录后自动在后台运行）'
$shortcut.IconLocation = $shortcut.TargetPath + ',0'
$shortcut.Save()

Write-Output ('已加入 Windows 启动栏：' + $shortcutPath)
Write-Output ('启动脚本：' + $launcher)
if (-not $OpenPanelOnStartup) {
    Write-Output '登录后仅后台启动，不自动打开浏览器；需要自动打开面板请加 -OpenPanelOnStartup。'
}
