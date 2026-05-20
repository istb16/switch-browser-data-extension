Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    $targets = @("manifest.json", "popup", "options", "lib", "icons", "content", "_locales") |
        Where-Object { Test-Path $_ }
    if (Test-Path "background") { $targets += "background" }

    if (Test-Path "manifest.zip") { Remove-Item "manifest.zip" }
    Compress-Archive -Path $targets -DestinationPath "manifest.zip"
    Write-Host "Created manifest.zip"
} finally {
    Pop-Location
}
