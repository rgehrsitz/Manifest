# Desktop Chrome Policy

Manifest uses the native operating-system frame on Windows and Linux. Those
platforms should not reserve renderer space for macOS traffic lights, and the
renderer should not add custom draggable titlebar regions when the native frame
is visible.

On macOS, Manifest uses Electron's `hiddenInset` titlebar so the content can sit
under the native traffic-light controls. The renderer reserves left padding for
those controls and marks only the project titlebar plus a narrow empty top strip
as draggable. Interactive controls inside the titlebar stay in `no-drag`
regions.

The shared `desktopChromeForPlatform` helper is the source of truth for this
policy so main-process window options, preload platform data, and renderer layout
stay aligned.
