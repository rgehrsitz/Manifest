import { describe, expect, it } from 'vitest'
import { detectCloudSyncPath } from '@shared/cloud-sync'

describe('detectCloudSyncPath', () => {
  it('detects iCloud Drive paths on macOS', () => {
    expect(detectCloudSyncPath('/Users/robert/Library/Mobile Documents/com~apple~CloudDocs/Lab')?.provider)
      .toBe('iCloud Drive')
    expect(detectCloudSyncPath('/Users/robert/iCloud Drive/Lab')?.provider)
      .toBe('iCloud Drive')
  })

  it('detects Dropbox, OneDrive, Google Drive, and Box paths', () => {
    expect(detectCloudSyncPath('/Users/robert/Dropbox/Projects/Lab')?.provider).toBe('Dropbox')
    expect(detectCloudSyncPath('C:\\Users\\Robert\\OneDrive - Lab\\Manifest\\Project')?.provider).toBe('OneDrive')
    expect(detectCloudSyncPath('/Users/robert/Library/CloudStorage/GoogleDrive-robert/My Drive/Lab')?.provider)
      .toBe('Google Drive')
    expect(detectCloudSyncPath('/Users/robert/Library/CloudStorage/Box-Box/Lab')?.provider)
      .toBe('Box')
  })

  it('does not match ordinary folders that merely contain provider names as substrings', () => {
    expect(detectCloudSyncPath('/Users/robert/Code/onedrive-adapter/Lab')).toBeNull()
    expect(detectCloudSyncPath('/Users/robert/Code/dropbox-importer/Lab')).toBeNull()
  })
})
