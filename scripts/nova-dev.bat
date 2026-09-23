@echo off
:: Nova IDE dev launcher.
::   scripts\nova-dev.bat <pasta-do-projeto> [outros argumentos do code.bat]
:: In dev the first positional argument code.bat passes (".") is Electron's app path,
:: so the project folder must come after it or the window opens empty.
setlocal

:: A user-level ELECTRON_RUN_AS_NODE=1 makes Electron run as plain Node and crash on startup.
set ELECTRON_RUN_AS_NODE=

if "%~1"=="" (
	echo Uso: scripts\nova-dev.bat ^<pasta-do-projeto^> [argumentos extras]
	echo Sem uma pasta a Nova IDE abre uma janela vazia, sem workspace.
	exit /b 1
)

pushd %~dp0\..
if not exist ".build\nova-nls\pt-br\messages.json" (
	node build\nova\devNls.ts pt-br || (popd & exit /b 1)
)
if not exist "out\vs\base\browser\ui\codicons\codicon\codicon.ttf" (
	call npm run gulp copy-codicons
	copy /y "src\vs\base\browser\ui\codicons\codicon\codicon.ttf" "out\vs\base\browser\ui\codicons\codicon\codicon.ttf" >nul
)
popd

call "%~dp0code.bat" "%~f1" %2 %3 %4 %5 %6 %7 %8 %9
endlocal
