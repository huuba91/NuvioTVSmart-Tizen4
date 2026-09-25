[CmdletBinding()]
param(
  [string]$Device = "192.168.129.0:26101",
  [string]$DeviceName = "UE49NU7100",
  [string]$SigningProfile = "NU7100-Nuvio",
  [string]$TizenStudio = "C:\tizen-studio",
  [switch]$SkipBuild,
  [switch]$SkipInstall,
  [switch]$Launch,
  [switch]$FollowLogs
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$NpmCli = Join-Path (Split-Path -Parent $Node) "node_modules\npm\bin\npm-cli.js"
$TizenCli = Join-Path $TizenStudio "tools\ide\bin\tizen.bat"
$Sdb = Join-Path $TizenStudio "tools\sdb.exe"
$PackageMetadata = Get-Content -Raw -LiteralPath (Join-Path $ProjectRoot "package.json") | ConvertFrom-Json
$PackageVersion = ([string]$PackageMetadata.version -replace "^v", "")
$UnsignedWgt = Join-Path $ProjectRoot "NuvioTV001_$PackageVersion.wgt"
$DeployDirectory = Join-Path $ProjectRoot ".cache\tizen4-deploy"
$DeployWgt = Join-Path $DeployDirectory "NuvioTV001_$PackageVersion.wgt"
$ApplicationId = "NuvioTV001.NuvioTV"

foreach ($RequiredPath in @($TizenCli, $Sdb)) {
  if (-not (Test-Path -LiteralPath $RequiredPath)) {
    throw "Required Tizen tool not found: $RequiredPath"
  }
}

if (-not (Test-Path -LiteralPath $NpmCli)) {
  $NpmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
} else {
  $NpmCommand = $null
}

Push-Location $ProjectRoot
try {
  if (-not $SkipBuild) {
    if ($NpmCommand) {
      & $NpmCommand run build
    } else {
      & $Node $NpmCli run build
    }
    if ($LASTEXITCODE -ne 0) { throw "Frontend build failed with exit code $LASTEXITCODE" }

    & $Node (Join-Path $ProjectRoot "scripts\package-tizen.mjs")
    if ($LASTEXITCODE -ne 0) { throw "Tizen packaging failed with exit code $LASTEXITCODE" }
  }

  if (-not (Test-Path -LiteralPath $UnsignedWgt)) {
    throw "Unsigned WGT not found: $UnsignedWgt"
  }

  New-Item -ItemType Directory -Force -Path $DeployDirectory | Out-Null
  Copy-Item -LiteralPath $UnsignedWgt -Destination $DeployWgt -Force

  # This uses the existing profile only. It never creates or modifies a
  # certificate, private key, or security profile.
  & $TizenCli package -t wgt -s $SigningProfile -- $DeployWgt
  if ($LASTEXITCODE -ne 0) { throw "WGT signing failed with exit code $LASTEXITCODE" }

  & $Sdb connect $Device
  if ($LASTEXITCODE -ne 0) { throw "SDB connection failed for $Device" }
  $ConnectedDevices = (& $Sdb devices | Out-String)
  if ($ConnectedDevices -notmatch [regex]::Escape($Device)) {
    throw "Tizen TV is not listed by SDB at $Device"
  }

  if (-not $SkipInstall) {
    & $Sdb -s $Device install $DeployWgt
    if ($LASTEXITCODE -ne 0) { throw "WGT installation failed with exit code $LASTEXITCODE" }
  }

  if ($Launch) {
    & $Sdb -s $Device shell 0 execute $ApplicationId
    if ($LASTEXITCODE -ne 0) { throw "Application launch failed with exit code $LASTEXITCODE" }
  }

  if ($FollowLogs) {
    & $Sdb -s $Device dlog
  }

  Write-Host "Tizen 4 deployment artifact: $DeployWgt"
  Write-Host "Target: $DeviceName ($Device)"
} finally {
  Pop-Location
}
