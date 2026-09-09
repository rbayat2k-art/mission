[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$JavaHome,
    [Parameter(Mandatory=$true)][string]$SigningDirectory,
    [Parameter(Mandatory=$true)][string]$BackupDirectory
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Key generation is an explicit one-time action, not part of the build. Never
# generate a replacement automatically when the permanent key is unavailable.
$javaRoot = (Resolve-Path -LiteralPath $JavaHome).Path
$keytool = Join-Path $javaRoot 'bin\keytool.exe'
if (-not (Test-Path -LiteralPath $keytool -PathType Leaf)) { throw 'JDK keytool is unavailable.' }
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$signRoot = [IO.Path]::GetFullPath($SigningDirectory).TrimEnd('\')
$backupRoot = [IO.Path]::GetFullPath($BackupDirectory).TrimEnd('\')
foreach ($directory in @($signRoot, $backupRoot)) {
    if ($directory -eq $repoRoot -or $directory.StartsWith($repoRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Signing material must remain outside the repository.'
    }
    if (Test-Path -LiteralPath $directory) { throw 'Signing target already exists; refuse to replace a key or backup.' }
    $parent = Split-Path -Parent $directory
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'Create and verify the parent directory first.' }
    if ((Get-Item -LiteralPath $parent).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked signing parent is not allowed.' }
}
if ($signRoot -eq $backupRoot -or $backupRoot.StartsWith($signRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or $signRoot.StartsWith($backupRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Primary and backup directories must be separate.'
}

function New-PrivateDirectory([string]$Path) {
    $null = New-Item -ItemType Directory -Path $Path
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}
New-PrivateDirectory $signRoot
New-PrivateDirectory $backupRoot
$bytes = New-Object byte[] 48
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$password = [Convert]::ToBase64String($bytes)
$secure = ConvertTo-SecureString -String $password -AsPlainText -Force
$secure | Export-Clixml -LiteralPath (Join-Path $signRoot 'password.dpapi.xml')
$keystore = Join-Path $signRoot 'tapra-employee-release.p12'
$start = $null
try {
    # The password goes into a child-process environment, never its command line.
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $keytool
    $start.Arguments = '-genkeypair -alias tapra-employee-release -keystore "' + $keystore + '" -storetype PKCS12 -keyalg RSA -keysize 3072 -sigalg SHA256withRSA -validity 10000 -dname "CN=TAPRA Employee Release, O=TAPRA" -storepass:env TAPRA_SIGNING_PASSWORD -keypass:env TAPRA_SIGNING_PASSWORD -noprompt'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.EnvironmentVariables['TAPRA_SIGNING_PASSWORD'] = $password
    $process = [Diagnostics.Process]::Start($start)
    $outTask = $process.StandardOutput.ReadToEndAsync()
    $errorTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(60000)) { $process.Kill(); throw 'Key creation timed out; preserve files for investigation.' }
    $null = $outTask.Result
    $null = $errorTask.Result
    if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $keystore -PathType Leaf)) { throw 'Key creation failed; no replacement key was attempted.' }
    $certificate = Join-Path $signRoot 'release-certificate.cer'
    $start.Arguments = '-exportcert -alias tapra-employee-release -keystore "' + $keystore + '" -storetype PKCS12 -storepass:env TAPRA_SIGNING_PASSWORD -file "' + $certificate + '"'
    $process = [Diagnostics.Process]::Start($start)
    $outTask = $process.StandardOutput.ReadToEndAsync()
    $errorTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(60000)) { $process.Kill(); throw 'Public certificate export timed out.' }
    $null = $outTask.Result
    $null = $errorTask.Result
    if ($process.ExitCode -ne 0) { throw 'Public certificate export failed.' }
    $identity = [ordered]@{
        applicationId = 'ir.taprasystem.employee'
        alias = 'tapra-employee-release'
        certificateSha256 = (Get-FileHash -LiteralPath $certificate -Algorithm SHA256).Hash.ToLowerInvariant()
        createdUtc = [DateTime]::UtcNow.ToString('o')
        passwordProtection = 'DPAPI CurrentUser; not portable to another Windows account or a reset installation'
    }
    $identity | ConvertTo-Json | Out-File -LiteralPath (Join-Path $signRoot 'signing-identity.json') -Encoding utf8
    foreach ($name in @('tapra-employee-release.p12', 'password.dpapi.xml', 'release-certificate.cer', 'signing-identity.json')) {
        $source = Join-Path $signRoot $name
        $destination = Join-Path $backupRoot $name
        Copy-Item -LiteralPath $source -Destination $destination -ErrorAction Stop
        if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash) { throw 'Signing backup verification failed.' }
    }
    Write-Output 'Permanent signing key created outside Git. Restricted primary and local backup verified. Password is Windows-user protected; no portable/off-device recovery is claimed.'
} finally {
    $password = $null
    $secure.Dispose()
    [Array]::Clear($bytes, 0, $bytes.Length)
    $rng.Dispose()
    if ($null -ne $start) { $start.EnvironmentVariables.Remove('TAPRA_SIGNING_PASSWORD') }
}
