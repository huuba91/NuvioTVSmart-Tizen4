[CmdletBinding()]
param(
  [string]$Device = "192.168.129.0:26101",
  [string]$TizenStudio = "C:\tizen-studio",
  [ValidateRange(5, 300)]
  [int]$IntervalSeconds = 20,
  [switch]$RunOnce
)

$ErrorActionPreference = "Stop"
$Sdb = Join-Path $TizenStudio "tools\sdb.exe"
if (-not (Test-Path -LiteralPath $Sdb)) {
  throw "Required Tizen SDB tool not found: $Sdb"
}

$PreviousState = ""
do {
  $Devices = (& $Sdb devices 2>&1 | Out-String)
  $Connected = $Devices -match [regex]::Escape($Device)
  if (-not $Connected) {
    & $Sdb connect $Device 2>&1 | Out-Null
    $Devices = (& $Sdb devices 2>&1 | Out-String)
    $Connected = $Devices -match [regex]::Escape($Device)
  }

  $State = if ($Connected) { "connected" } else { "waiting" }
  if ($State -ne $PreviousState -or $RunOnce) {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Tizen SDB ${State}: $Device"
    $PreviousState = $State
  }

  if (-not $RunOnce) {
    Start-Sleep -Seconds $IntervalSeconds
  }
} while (-not $RunOnce)
