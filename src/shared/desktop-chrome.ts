export type DesktopPlatform = 'darwin' | 'win32' | 'linux' | 'other'
export type DesktopTitlebarStyle = 'hiddenInset' | 'default'

export interface DesktopChromeInfo {
  platform: DesktopPlatform
  titleBarStyle: DesktopTitlebarStyle
  usesNativeFrame: boolean
  usesHiddenInsetTitlebar: boolean
  reservesTrafficLightSpace: boolean
  supportsWindowDragRegion: boolean
}

export function desktopChromeForPlatform(platform: string): DesktopChromeInfo {
  const normalized = normalizeDesktopPlatform(platform)
  const usesHiddenInsetTitlebar = normalized === 'darwin'

  return {
    platform: normalized,
    titleBarStyle: usesHiddenInsetTitlebar ? 'hiddenInset' : 'default',
    usesNativeFrame: !usesHiddenInsetTitlebar,
    usesHiddenInsetTitlebar,
    reservesTrafficLightSpace: usesHiddenInsetTitlebar,
    supportsWindowDragRegion: usesHiddenInsetTitlebar,
  }
}

function normalizeDesktopPlatform(platform: string): DesktopPlatform {
  if (platform === 'darwin' || platform === 'win32' || platform === 'linux') return platform
  return 'other'
}
