; ZHU installer hooks (Tauri NSIS).
;
; ZHU runs its engine inside zhu.exe, which the Tauri installer closes. Versions before that ran
; the engine as a separate zhu-engine.exe, which the installer did not know about; stopping it
; is kept for updates from those versions.
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

; 3. The six large NVIDIA libraries travel compressed (packaging/pack_cuda.py): compressing them
;    inside the installer took most of every build. The engine unpacks them in place, here, once
;    the files are on disk. If this step fails or is skipped, the engine does it at its next
;    start, and until then it works on the processor instead of the graphics card.
!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Unpacking the GPU libraries..."
  nsExec::Exec '"$INSTDIR\zhu-engine\zhu-engine.exe" --unpack-cuda'
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro ZHU_STOP_ENGINE
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  RMDir /r "$INSTDIR\zhu-engine"
  RMDir "$INSTDIR"
!macroend
