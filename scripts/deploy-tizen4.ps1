[CmdletBinding()]
param(
  [string]$Device = "192.168.129.0:26101",
  [string]$DeviceName = "UE49NU7100",
  [string]$SigningProfile = "NU7100-Nuvio",
  [string]$TizenStudio = "C:\tizen-studio",
  [ValidateRange(0, 300)]
  [int]$ConnectTimeoutSeconds = 45,
  [ValidateRange(0, 3)]
  [int]$InstallRetryCount = 1,
  [switch]$SkipBuild,
  [switch]$SkipInstall,
  [switch]$Launch,
  [switch]$FollowLogs,
  [switch]$IncludePluginService
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
$SignedDirectory = Join-Path $DeployDirectory "signed"
$SignedWgt = Join-Path $SignedDirectory "NuvioTV001_$PackageVersion.wgt"
$ApplicationId = "NuvioTV001.NuvioTV"
$RuntimeEnvVerifier = Join-Path $ProjectRoot "scripts\verify-tizen-runtime-env.mjs"
# Every Tizen CLI install leaves its WGT here and the TV never deletes it; this
# firmware has no usable shell, so the only way to free the space is to push an
# empty file over each copy. Once enough accumulate, WAS rejects every install
# with download error 116 (seen 2026-10-04: 84 stale uploads).
$TvUploadDirectory = "/home/owner/share/tmp/sdk_tools/tmp"

# Empties leftover Nuvio uploads on the TV: every NuvioTV001_<major>.<minor>.<patch>
# from .0 up to the current version, plus the WGT name about to be installed.
function Clear-TizenUploads {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Target,
    [Parameter(Mandatory = $true)]
    [string]$SdbPath,
    [Parameter(Mandatory = $true)]
    [string]$Version
  )

  $Parts = $Version.Split(".")
  if ($Parts.Count -lt 3) { return }
  $Prefix = "$($Parts[0]).$($Parts[1])"
  $Empty = Join-Path ([System.IO.Path]::GetTempPath()) "nuvio-empty-upload.wgt"
  [System.IO.File]::WriteAllBytes($Empty, [byte[]]@())
  $Cleared = 0
  try {
    for ($Patch = 0; $Patch -le [int]$Parts[2]; $Patch++) {
      try {
        & $SdbPath -s $Target push $Empty "$TvUploadDirectory/NuvioTV001_$Prefix.$Patch.wgt" 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { $Cleared += 1 }
      } catch {
        # a copy that cannot be emptied only costs its space
      }
    }
  } finally {
    Remove-Item -LiteralPath $Empty -ErrorAction SilentlyContinue
  }
  Write-Host "Emptied $Cleared leftover Nuvio upload(s) on the TV."
}

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

function Assert-SignedWgt {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Tizen CLI reported success but did not create the signed WGT: $Path"
  }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $Archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
  try {
    foreach ($SignatureName in @("author-signature.xml", "signature1.xml")) {
      if (-not $Archive.GetEntry($SignatureName)) {
        throw "Tizen CLI output is unsigned: missing $SignatureName in $Path"
      }
    }
  } finally {
    $Archive.Dispose()
  }
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
    $PreviousIncludePluginService = $env:TIZEN_INCLUDE_PLUGIN_SERVICE
    $env:NUVIO_REQUIRE_LOCAL_PROPERTIES = "1"
    # Executable scraper plugins require the newer Tizen service runtime.
    # The Tizen 4 deployment always keeps EngineFS but excludes PluginService
    # unless an explicit diagnostic run requests it.
    $env:TIZEN_INCLUDE_PLUGIN_SERVICE = if ($IncludePluginService) { "1" } else { "0" }
    if ($NpmCommand) {
      & $NpmCommand run build
    } else {
      & $Node $NpmCli run build
    }
    if ($LASTEXITCODE -ne 0) { throw "Frontend build failed with exit code $LASTEXITCODE" }

    & $Node (Join-Path $ProjectRoot "scripts\package-tizen.mjs")
    if ($LASTEXITCODE -ne 0) { throw "Tizen packaging failed with exit code $LASTEXITCODE" }
    $env:NUVIO_REQUIRE_LOCAL_PROPERTIES = $PreviousRequireLocalProperties
    $env:TIZEN_INCLUDE_PLUGIN_SERVICE = $PreviousIncludePluginService
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

  if (Test-Path -LiteralPath $SignedDirectory) {
    Remove-Item -LiteralPath $SignedDirectory -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $SignedDirectory | Out-Null

  # This uses the existing profile only. It never creates or modifies a
  # certificate, private key, or security profile. Use a distinct output
  # directory: repackaging a WGT in place can return success without adding
  # signature files on older Tizen Studio CLI versions.
  & $TizenCli package -t wgt -s $SigningProfile -o $SignedDirectory -- $DeployWgt
  if ($LASTEXITCODE -ne 0) { throw "WGT signing failed with exit code $LASTEXITCODE" }
  Assert-SignedWgt -Path $SignedWgt
  Copy-Item -LiteralPath $SignedWgt -Destination $DeployWgt -Force

  Wait-TizenDevice -Target $Device -SdbPath $Sdb -TimeoutSeconds $ConnectTimeoutSeconds

  if (-not $SkipInstall) {
    Clear-TizenUploads -Target $Device -SdbPath $Sdb -Version $PackageVersion
    # Samsung clears this temporary permission across some cold boots even
    # while SDB reconnects successfully. Without it WAS reports misleading
    # download error 116 before package validation.
    & $TizenCli install-permit -s $Device
    if ($LASTEXITCODE -ne 0) {
      throw "Tizen developer installation permission failed with exit code $LASTEXITCODE"
    }
    # The NU7100 accepts this package through the Tizen CLI installer. Direct
    # `sdb install` can upload the WGT and then close without invoking WAS.
    # Immediately after install-permit, WAS occasionally rejects the first
    # request with 116 and accepts the identical second request. Retry only
    # that pre-validation condition; all other installer failures remain
    # immediate and visible.
    $InstallAttempt = 0
    while ($true) {
      $InstallAttempt += 1
      $InstallOutput = @(& $TizenCli install -n (Split-Path -Leaf $DeployWgt) -s $Device -- $DeployDirectory 2>&1)
      $InstallExitCode = $LASTEXITCODE
      $InstallOutput | ForEach-Object { Write-Host $_ }
      if ($InstallExitCode -eq 0) {
        # The installed copy lives elsewhere; the upload is only dead weight now.
        Clear-TizenUploads -Target $Device -SdbPath $Sdb -Version $PackageVersion
        break
      }

      $InstallText = $InstallOutput -join "`n"
      $IsDownload116 = $InstallText -match "download failed\[116\]"
      if ($IsDownload116 -and $InstallAttempt -le $InstallRetryCount) {
        Write-Host "Samsung WAS returned download error 116; refreshing install permission and retrying without rebuilding ($InstallAttempt/$InstallRetryCount)..."
        & $TizenCli install-permit -s $Device
        if ($LASTEXITCODE -ne 0) {
          throw "Tizen developer installation permission refresh failed with exit code $LASTEXITCODE"
        }
        Start-Sleep -Seconds 2
        continue
      }
      if ($IsDownload116) {
        throw @"
Tizen CLI installation failed with Samsung WAS download error 116.
The package transferred, SDB is connected, and developer install permission was refreshed, but the TV rejected all $InstallAttempt attempt(s) before validation.
Leftover uploads in $TvUploadDirectory from other apps or version lines can still fill the TV: empty them with sdb push of an empty file. Otherwise cold-boot the TV, confirm Developer Mode is still enabled for this PC, and retry. The installed Nuvio app and its data were not changed.
"@
      }
      throw "Tizen CLI installation failed with exit code $InstallExitCode"
    }
  }

  if ($Launch) {
    # This firmware may close interactive `sdb shell` even while package
    # installation works. The Tizen CLI run command uses the same connected
    # serial and is the reliable launcher on the NU7100.
    & $TizenCli run -p $ApplicationId -s $Device
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
