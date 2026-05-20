@echo off
setlocal

cd /d "%~dp0.."

if exist manifest.zip del manifest.zip

set TARGETS=manifest.json popup options lib icons content _locales
if exist background set TARGETS=%TARGETS% background

zip -r manifest.zip %TARGETS%
echo Created manifest.zip
