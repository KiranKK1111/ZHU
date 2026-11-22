; ZHU installer hooks (Tauri NSIS).
;
; The Tauri installer closes zhu.exe, but it does not know about the engine child process.
; Measured in real uninstall tests: DLLs still loaded by a shutting-down zhu-engine.exe were locked
; and silently left behind (31 files / 97 MB, then 41 files / 126 MB with a fixed 1.5 s wait,
; because a process with CUDA libraries loaded can take longer to release its files).
;
; 1. Stop the engine and WAIT until the process has really exited (bounded at 15 s).
; 2. After uninstall, sweep the engine folder: it only ever contains program files
;    (user data lives in %LOCALAPPDATA%\app.zhu.desktop\data and is not touched).

!macro ZHU_STOP_ENGINE
  nsExec::Exec 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Stop-Process -Name zhu-engine -Force -ErrorAction SilentlyContinue; Wait-Process -Name zhu-engine -Timeout 15 -ErrorAction SilentlyContinue"'
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro ZHU_STOP_ENGINE
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro ZHU_STOP_ENGINE
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  RMDir /r "$INSTDIR\zhu-engine"
  RMDir "$INSTDIR"
!macroend
