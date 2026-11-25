# 用本機私鑰簽署 TwPriceOverlay.exe，產生 TwPriceOverlay.exe.sig（RSA-3072、SHA-256、PKCS#1 v1.5）
#
# 小程式的自動更新會用內建的公鑰驗證這個簽章，驗證不過就不安裝。
# 私鑰只存在這台電腦（%USERPROFILE%\.tw-price-signing\private.xml），絕對不要放進專案或上傳。
# 就算 GitHub 帳號被入侵，沒有這把私鑰也無法讓使用者自動安裝被竄改的 exe。
#
# 用法：改完 TwPriceOverlay.cs → build-exe.cmd → 本腳本 → commit（exe 與 .sig 一起）
$ErrorActionPreference = 'Stop'
$key = Join-Path $env:USERPROFILE '.tw-price-signing\private.xml'
if (-not (Test-Path $key)) { throw "找不到私鑰：$key" }
$exe = Join-Path $PSScriptRoot 'TwPriceOverlay.exe'
$rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider
$rsa.FromXmlString([IO.File]::ReadAllText($key))
$sig = $rsa.SignData([IO.File]::ReadAllBytes($exe), "SHA256")  # RSACryptoServiceProvider：SHA-256 + PKCS#1 v1.5
[IO.File]::WriteAllText("$exe.sig", [Convert]::ToBase64String($sig))
"已簽署：TwPriceOverlay.exe.sig"
