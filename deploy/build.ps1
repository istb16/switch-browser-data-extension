Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    $targets = @("manifest.json", "popup", "options", "lib", "icons", "content", "_locales") |
        Where-Object { Test-Path $_ }
    if (Test-Path "background") { $targets += "background" }

    $zip = "store/manifest.zip"
    if (Test-Path $zip) { Remove-Item $zip }
    Compress-Archive -Path $targets -DestinationPath $zip
    Write-Host "Created $zip"
} finally {
    Pop-Location
}
