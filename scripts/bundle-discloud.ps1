Write-Host "📦 Compilando TypeScript..." -ForegroundColor Cyan
npm run build

Write-Host "📁 Preparando archivos para Discloud..." -ForegroundColor Cyan
$stage = "temp_discloud"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
if (Test-Path "discloud.zip") { Remove-Item "discloud.zip" -Force }

New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item "discloud.config", "package.json", "package-lock.json", ".env" -Destination $stage
Copy-Item "dist", "web" -Destination $stage -Recurse

New-Item -ItemType Directory -Path "$stage/data" | Out-Null
if (Test-Path "data/store.db*") {
    Copy-Item "data/store.db*" -Destination "$stage/data"
}

Write-Host "🗜️ Comprimiendo en discloud.zip..." -ForegroundColor Cyan
Compress-Archive -Path "$stage/*" -DestinationPath "discloud.zip" -Force
Remove-Item $stage -Recurse -Force

$sizeKb = [Math]::Round((Get-Item "discloud.zip").Length / 1024, 1)
Write-Host "✅ ¡Listo! Archivo 'discloud.zip' generado con éxito ($sizeKb KB)." -ForegroundColor Green
Write-Host "   Sube este archivo directamente a https://discloud.app/dashboard" -ForegroundColor Yellow
