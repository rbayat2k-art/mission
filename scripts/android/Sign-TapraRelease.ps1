[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$JavaHome,
    [Parameter(Mandatory=$true)][string]$BuildToolsDirectory,
    [Parameter(Mandatory=$true)][string]$SigningDirectory,
    [Parameter(Mandatory=$true)][string]$UnsignedApk,
    [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$javaRoot = (Resolve-Path -LiteralPath $JavaHome).Path
$tools = (Resolve-Path -LiteralPath $BuildToolsDirectory).Path
$signRoot = (Resolve-Path -LiteralPath $SigningDirectory).Path
$inputApk = (Resolve-Path -LiteralPath $UnsignedApk).Path
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
$java = Join-Path $javaRoot 'bin\java.exe'
$signerJar = Join-Path $tools 'lib\apksigner.jar'
$align = Join-Path $tools 'zipalign.exe'
$aapt = Join-Path $tools 'aapt.exe'
$keystore = Join-Path $signRoot 'tapra-employee-release.p12'
$passwordFile = Join-Path $signRoot 'password.dpapi.xml'
$identityFile = Join-Path $signRoot 'signing-identity.json'
foreach ($file in @($java, $signerJar, $align, $aapt, $keystore, $passwordFile, $identityFile, $inputApk)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'A required release/signing file is missing. No new key will be generated.' }
    if ((Get-Item -LiteralPath $file).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked input is not allowed.' }
}
$identity = Get-Content -LiteralPath $identityFile -Raw | ConvertFrom-Json
if ($identity.applicationId -ne 'ir.taprasystem.employee' -or $identity.certificateSha256 -notmatch '^[0-9a-f]{64}$') { throw 'Invalid permanent signing identity record.' }
if (Test-Path -LiteralPath $outputRoot) { throw 'Release output already exists; refuse to overwrite.' }
if (-not (Test-Path -LiteralPath (Split-Path -Parent $outputRoot) -PathType Container)) { throw 'Verify and create the output parent first.' }
$badging = & $aapt dump badging $inputApk 2>&1
if ($LASTEXITCODE -ne 0) { throw 'Input APK could not be inspected.' }
$badgingText = $badging -join "`n"
if ($badgingText -notmatch "package: name='ir.taprasystem.employee' versionCode='23' versionName='1.2.4'" -or $badgingText -notmatch "sdkVersion:'23'" -or $badgingText -notmatch "targetSdkVersion:'35'" -or $badgingText -match 'application-debuggable') { throw 'APK identity/version/SDK/debug policy did not match the approved release.' }
$manifest = & $aapt dump xmltree $inputApk AndroidManifest.xml 2>&1
if ($LASTEXITCODE -ne 0 -or ($manifest -join "`n") -match 'android:usesCleartextTraffic[^\r\n]*0xffffffff') { throw 'Release network policy is not acceptable.' }
$null = New-Item -ItemType Directory -Path $outputRoot
$aligned = Join-Path $outputRoot 'tapra-employee-v1.2.4-aligned-unsigned.apk'
$signed = Join-Path $outputRoot 'tapra-employee-v1.2.4.apk'
& $align -p 4 $inputApk $aligned
if ($LASTEXITCODE -ne 0) { throw 'APK alignment failed.' }
$secure = Import-Clixml -LiteralPath $passwordFile
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$start = $null
try {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $java
    $start.Arguments = '-jar "' + $signerJar + '" sign --ks "' + $keystore + '" --ks-key-alias tapra-employee-release --ks-pass env:TAPRA_SIGNING_PASSWORD --key-pass env:TAPRA_SIGNING_PASSWORD --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true --v4-signing-enabled false --out "' + $signed + '" "' + $aligned + '"'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.EnvironmentVariables['TAPRA_SIGNING_PASSWORD'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    $process = [Diagnostics.Process]::Start($start)
    $outTask = $process.StandardOutput.ReadToEndAsync()
    $errorTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(60000)) { $process.Kill(); throw 'APK signing timed out.' }
    $null = $outTask.Result
    $null = $errorTask.Result
    if ($process.ExitCode -ne 0) { throw 'APK signing failed; no signer fallback was attempted.' }
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    $secure.Dispose()
    if ($null -ne $start) { $start.EnvironmentVariables.Remove('TAPRA_SIGNING_PASSWORD') }
}
$verification = & $java -jar $signerJar verify --verbose --print-certs --min-sdk-version 23 $signed 2>&1
if ($LASTEXITCODE -ne 0) { throw 'Signed APK verification failed.' }
if (($verification -join "`n") -notmatch ('Signer #1 certificate SHA-256 digest: ' + [regex]::Escape($identity.certificateSha256))) { throw 'APK certificate does not match the permanent signing identity.' }
& $align -c -p 4 $signed
if ($LASTEXITCODE -ne 0) { throw 'Signed APK alignment verification failed.' }
$verification | Out-File -LiteralPath (Join-Path $outputRoot 'signature-verification.txt') -Encoding utf8
$badging | Out-File -LiteralPath (Join-Path $outputRoot 'apk-badging.txt') -Encoding utf8
$hash = (Get-FileHash -LiteralPath $signed -Algorithm SHA256).Hash.ToLowerInvariant()
($hash + '  tapra-employee-v1.2.4.apk') | Out-File -LiteralPath ($signed + '.sha256') -Encoding ascii
Write-Output ('Signed APK verified: ' + $signed)
Write-Output ('SHA256: ' + $hash)
