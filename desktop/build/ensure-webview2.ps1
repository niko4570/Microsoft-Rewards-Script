$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Runtime provisioning is restricted to disposable GitHub Actions Windows runners.'
}

# Edge Stable is not the WebView2 Runtime. Check the locations documented by Microsoft.
function Get-WebView2Version {
    $client = 'Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    foreach ($key in @("HKLM:\SOFTWARE\WOW6432Node\$client", "HKLM:\SOFTWARE\$client", "HKCU:\SOFTWARE\$client")) {
        $value = (Get-ItemProperty -LiteralPath $key -Name pv -ErrorAction SilentlyContinue).pv
        $version = $null
        if ([version]::TryParse($value, [ref]$version) -and $version -gt [version]'0.0.0.0') { return $value }
    }
    return $null
}

$version = Get-WebView2Version
if (-not $version) {
    Write-Output 'WebView2 Runtime is missing; installing Microsoft Evergreen Runtime before portable UI tests.'
    $installer = Join-Path $env:RUNNER_TEMP 'MicrosoftEdgeWebview2Setup.exe'
    Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $installer
    $signature = Get-AuthenticodeSignature -LiteralPath $installer
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
        throw 'WebView2 bootstrapper does not have a valid Microsoft signature.'
    }
    $process = Start-Process -FilePath $installer -ArgumentList @('/silent', '/install') -PassThru
    if (-not $process.WaitForExit(180000)) {
        $process.Kill()
        throw 'WebView2 Runtime installation timed out.'
    }
    $version = Get-WebView2Version
    if (-not $version) { throw "WebView2 Runtime is still missing (bootstrapper exit $($process.ExitCode))." }
}
Write-Output "WebView2 Runtime ready: $version"
