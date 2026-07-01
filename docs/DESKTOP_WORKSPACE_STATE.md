# Desktop Workspace State

Manifest stores app-level workspace state under Electron `userData`.

- Window bounds, maximized state, and fullscreen state are restored on launch.
  Bounds are ignored if they no longer intersect a current display work area.
- Tree and snapshot pane widths are restored in the renderer and clamped to the
  same ranges used by drag resize.
- The last Open Project and Create Project directories are reused as dialog
  defaults.
- Manifest does not auto-open the last project. The welcome screen shows a
  one-click Reopen action when the last project still exists, while the File >
  Open Recent menu remains available for broader recent-project history.
