@echo off
rem 用 Windows 內建的 .NET Framework 4 C# 編譯器產生 TwPriceOverlay.exe（不需要另外安裝任何東西）
cd /d "%~dp0"
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /optimize+ /codepage:65001 ^
  /out:TwPriceOverlay.exe /win32icon:icon.ico ^
  /r:System.Windows.Forms.dll /r:System.Drawing.dll ^
  TwPriceOverlay.cs
