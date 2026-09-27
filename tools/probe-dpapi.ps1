# Probe Windows DPAPI (ProtectedData) availability for BUPT-Notify.
$ErrorActionPreference = 'Continue'
Write-Output "PSVersion: $($PSVersionTable.PSVersion)"
try {
  Add-Type -AssemblyName System.Security -ErrorAction Stop
  Write-Output "Add-Type: ok"
} catch {
  Write-Output "Add-Type FAILED: $($_.Exception.Message)"
  exit 2
}

try {
  $plain = 'probe-password-123'
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($plain)
  $enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
  $b64 = [Convert]::ToBase64String($enc)
  Write-Output "Protect: ok, cipher b64 length = $($b64.Length)"

  $back = [System.Security.Cryptography.ProtectedData]::Unprotect(
    [Convert]::FromBase64String($b64), $null, 'CurrentUser')
  $dec = [System.Text.Encoding]::UTF8.GetString($back)
  Write-Output "Unprotect: ok, roundtrip match = $($dec -eq $plain)"
  exit 0
} catch {
  Write-Output "DPAPI FAILED: $($_.Exception.GetType().FullName): $($_.Exception.Message)"
  exit 1
}
