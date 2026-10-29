param(
    [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
    [string[]]$Files
)

# 按用户规则：在文件所在目录生成 bakup\<时间戳>\，只备份被编辑的文件，
# 记录 bakup.md，最多保留 5 份，自动清理更早的备份。

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$groups = $Files |
    Where-Object { Test-Path -LiteralPath $_ } |
    ForEach-Object { Get-Item -LiteralPath $_ } |
    Group-Object DirectoryName

foreach ($group in $groups) {
    $bakRoot = Join-Path $group.Name 'bakup'
    New-Item -ItemType Directory -Force -Path $bakRoot | Out-Null

    $dest = Join-Path $bakRoot $stamp
    New-Item -ItemType Directory -Force -Path $dest | Out-Null

    $names = @()
    foreach ($item in $group.Group) {
        Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $dest $item.Name) -Force
        $names += $item.Name
    }

    $log = Join-Path $bakRoot 'bakup.md'
    if (-not (Test-Path -LiteralPath $log)) {
        Set-Content -LiteralPath $log -Value "# 备份记录`n" -Encoding UTF8
    }
    Add-Content -LiteralPath $log -Encoding UTF8 -Value "- $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $($names -join ', ')"

    $dirs = Get-ChildItem -LiteralPath $bakRoot -Directory | Sort-Object Name -Descending
    if ($dirs.Count -gt 5) {
        $dirs | Select-Object -Skip 5 | ForEach-Object {
            Remove-Item -LiteralPath $_.FullName -Recurse -Force
        }
    }
}

Write-Output "bakup done: $stamp"
