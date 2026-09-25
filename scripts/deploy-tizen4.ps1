[CmdletBinding()]
param(
  [string]$Device = "192.168.129.0:26101",
  [string]$DeviceName = "UE49NU7100",
  [string]$SigningProfile = "NU7100-Nuvio",
  [string]$TizenStudio = "C:\tizen-studio",
  [ValidateRange(0, 300)]
  [int]$ConnectTimeoutSeconds = 45,
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
$RuntimeEnvVerifier = Join-Path $ProjectRoot "scripts\verify-tizen-runtime-env.mjs"

function Wait-TizenDevice {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Target,
    [Parameter(Mandatory = $true)]
    [string]$SdbPath,
    [int]$TimeoutSeconds = 45
  )

  $Stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $Attempt = 0
  do {
    $Attempt += 1
    # SDB can return success while a stale TV daemon remains absent from the
    # device list, so the authoritative check is always `sdb devices`.
    & $SdbPath connect $Target 2>&1 | Out-Null
    $ConnectedDevices = (& $SdbPath devices 2>&1 | Out-String)
    if ($ConnectedDevices -match [regex]::Escape($Target)) {
      Write-Host "Tizen TV connected at $Target (attempt $Attempt)."
      return
    }

    if ($Stopwatch.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
      throw "Tizen TV did not appear in SDB at $Target within $TimeoutSeconds seconds. Confirm the TV is awake, Developer Mode is enabled, and the host PC IP is allowed."
    }
    Write-Host "Waiting for Tizen TV at $Target..."
    Start-Sleep -Seconds ([Math]::Min(3, [Math]::Max(1, $TimeoutSeconds - [int]$Stopwatch.Elapsed.TotalSeconds)))
  } while ($true)
}

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
    $PreviousRequireLocalProperties = $env:NUVIO_REQUIRE_LOCAL_PROPERTIES
    $env:NUVIO_REQUIRE_LOCAL_PROPERTIES = "1"
    if ($NpmCommand) {
      & $NpmCommand run build
    } else {
      & $Node $NpmCli run build
    }
    if ($LASTEXITCODE -ne 0) { throw "Frontend build failed with exit code $LASTEXITCODE" }

    & $Node (Join-Path $ProjectRoot "scripts\package-tizen.mjs")
    if ($LASTEXITCODE -ne 0) { throw "Tizen packaging failed with exit code $LASTEXITCODE" }
    $env:NUVIO_REQUIRE_LOCAL_PROPERTIES = $PreviousRequireLocalProperties
  }

  if (-not (Test-Path -LiteralPath $UnsignedWgt)) {
    throw "Unsigned WGT not found: $UnsignedWgt"
  }

  & $Node $RuntimeEnvVerifier $UnsignedWgt
  if ($LASTEXITCODE -ne 0) {
    throw "Tizen WGT runtime configuration verification failed with exit code $LASTEXITCODE"
  }

  New-Item -ItemType Directory -Force -Path $DeployDirectory | Out-Null
  Copy-Item -LiteralPath $UnsignedWgt -Destination $DeployWgt -Force

  # This uses the existing profile only. It never creates or modifies a
  # certificate, private key, or security profile.
  & $TizenCli package -t wgt -s $SigningProfile -- $DeployWgt
  if ($LASTEXITCODE -ne 0) { throw "WGT signing failed with exit code $LASTEXITCODE" }

  Wait-TizenDevice -Target $Device -SdbPath $Sdb -TimeoutSeconds $ConnectTimeoutSeconds

  if (-not $SkipInstall) {
    # The NU7100 accepts this package through the Tizen CLI installer. Direct
    # `sdb install` can upload the WGT and then close without invoking WAS.
    $InstallOutput = @(& $TizenCli install -n (Split-Path -Leaf $DeployWgt) -s $Device -- $DeployDirectory 2>&1)
    $InstallExitCode = $LASTEXITCODE
    $InstallOutput | ForEach-Object { Write-Host $_ }
    if ($InstallExitCode -ne 0) {
      $InstallText = $InstallOutput -join "`n"
      if ($InstallText -match "download failed\[116\]") {
        throw @"
Tizen CLI installation failed with Samsung WAS download error 116.
The package transferred and SDB is connected, but the TV rejected it before validation.
On this TV this can indicate unavailable Smart Hub/app download storage. Check Apps > Settings for free space, remove only unwanted apps if needed, then cold-boot the TV and retry. The installed Nuvio app and its data were not changed.
"@
      }
      throw "Tizen CLI installation failed with exit code $InstallExitCode"
    }
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
