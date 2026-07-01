# Desktop Close And Quit Save Semantics

Manifest autosaves quickly during normal editing, but desktop close and quit
paths also perform a final save.

- Project Close: cancels pending autosave, attempts a final save, then closes
  the project only after the save succeeds or the user chooses Close Anyway.
- Window Close: if a project is open, blocks the native close event, attempts a
  final save, then closes the window only after the save succeeds or the user
  chooses Close Anyway.
- App Quit: blocks the normal quit long enough to attempt a final save. If the
  save succeeds, Manifest resumes quitting. If it fails, the user can Retry,
  Quit Anyway, or Open Logs.
- OS Shutdown: follows Electron's normal quit path when the OS gives the app a
  quit event. If the OS terminates the process without allowing that flow,
  Manifest falls back to the last successful autosave/recovery data.
- Crash Recovery: crashes cannot show a final-save dialog, so recovery remains
  based on already-written autosave, manifest, snapshot, and recovery-point
  data.

Final-save failures are never silently ignored. The open project remains in
memory after a failed project-close save unless the user explicitly continues
anyway.
