@echo off
setlocal

cd /d "%~dp0.."

set ZIP=store\manifest.zip
if exist %ZIP% del %ZIP%

set TARGETS=manifest.json popup options lib icons content _locales
if exist background set TARGETS=%TARGETS% background

zip -r %ZIP% %TARGETS%
echo Created %ZIP%
