import { describe, expect, it } from 'vitest'
import { desktopChromeForPlatform } from '../../../src/shared/desktop-chrome'

describe('desktopChromeForPlatform', () => {
  it('uses hidden inset chrome on macOS', () => {
    expect(desktopChromeForPlatform('darwin')).toEqual({
      platform: 'darwin',
      titleBarStyle: 'hiddenInset',
      usesNativeFrame: false,
      usesHiddenInsetTitlebar: true,
      reservesTrafficLightSpace: true,
      supportsWindowDragRegion: true,
    })
  })

  it.each(['win32', 'linux'] as const)('uses native frame chrome on %s', (platform) => {
    expect(desktopChromeForPlatform(platform)).toEqual({
      platform,
      titleBarStyle: 'default',
      usesNativeFrame: true,
      usesHiddenInsetTitlebar: false,
      reservesTrafficLightSpace: false,
      supportsWindowDragRegion: false,
    })
  })

  it('falls back to native frame chrome on unknown desktop platforms', () => {
    expect(desktopChromeForPlatform('freebsd')).toMatchObject({
      platform: 'other',
      titleBarStyle: 'default',
      usesNativeFrame: true,
      reservesTrafficLightSpace: false,
      supportsWindowDragRegion: false,
    })
  })
})
