param(
    [Parameter(Mandatory = $true)][ValidateSet('enable', 'restore')][string]$Mode,
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][ValidateRange(1, 65535)][int]$Port,
    [Parameter(Mandatory = $true)][string]$StateFile
)

$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'WebView2 test policy is restricted to disposable GitHub Actions Windows runners.'
}

# Runtime 150+ ignores WEBVIEW2_* environment overrides for elevated hosts.
# Use the documented app-specific machine policy only for the duration of the smoke test.
# https://github.com/MicrosoftEdge/WebView2Feedback/issues/5645
$policy = 'SOFTWARE\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments'
$name = Split-Path $Executable -Leaf
$expected = "--remote-debugging-port=$Port"
$key = [Microsoft.Win32.Registry]::LocalMachine.CreateSubKey($policy)
try {
    if ($Mode -eq 'enable') {
        if (Test-Path -LiteralPath $StateFile) { throw 'A WebView2 test policy snapshot already exists.' }
        $hadValue = @($key.GetValueNames()) -contains $name
        $kind = if ($hadValue) { $key.GetValueKind($name).ToString() } else { 'String' }
        if ($kind -notin @('String', 'ExpandString')) { throw 'Refusing to replace an unexpected registry value type.' }
        $previous = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        @{ name = $name; hadValue = $hadValue; value = $previous; kind = $kind; expected = $expected } |
            ConvertTo-Json | Set-Content -LiteralPath $StateFile -Encoding UTF8
        $key.SetValue($name, $expected, [Microsoft.Win32.RegistryValueKind]::String)
        Write-Output "Temporary WebView2 CDP policy enabled for $name."
    } else {
        $state = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
        if ($state.name -ne $name -or $state.expected -cne $expected) { throw 'WebView2 test policy snapshot does not match this test.' }
        if ($key.GetValue($name) -cne $expected) { throw 'WebView2 policy changed externally; refusing to overwrite it.' }
        if ($state.hadValue) {
            $kind = [Microsoft.Win32.RegistryValueKind][Enum]::Parse([Microsoft.Win32.RegistryValueKind], $state.kind)
            $key.SetValue($name, $state.value, $kind)
        } else {
            $key.DeleteValue($name, $false)
        }
        Remove-Item -LiteralPath $StateFile
        Write-Output "Temporary WebView2 CDP policy restored for $name."
    }
} finally {
    $key.Dispose()
}
