export interface CloudSyncPathWarning {
  provider: 'iCloud Drive' | 'Dropbox' | 'OneDrive' | 'Google Drive' | 'Box'
  matchedPath: string
}

export function detectCloudSyncPath(projectPath: string): CloudSyncPathWarning | null {
  const normalized = normalizeForPathMatch(projectPath)
  if (!normalized) return null

  const segments = normalized.split('/').filter(Boolean)
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    const next = segments[i + 1] ?? ''
    const nextNext = segments[i + 2] ?? ''

    if (segment === 'library' && next === 'mobile documents') {
      return { provider: 'iCloud Drive', matchedPath: '/Library/Mobile Documents/' }
    }

    if (segment === 'icloud drive') {
      return { provider: 'iCloud Drive', matchedPath: 'iCloud Drive' }
    }

    if (segment === 'library' && next === 'cloudstorage') {
      const provider = providerFromCloudStorageSegment(nextNext)
      if (provider) {
        return { provider, matchedPath: `/Library/CloudStorage/${nextNext}` }
      }
    }

    const provider = providerFromStandaloneSegment(segment)
    if (provider) {
      return { provider, matchedPath: segment }
    }
  }

  return null
}

function normalizeForPathMatch(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase()
}

function providerFromCloudStorageSegment(segment: string): CloudSyncPathWarning['provider'] | null {
  if (segment.startsWith('dropbox')) return 'Dropbox'
  if (segment.startsWith('onedrive')) return 'OneDrive'
  if (segment.startsWith('googledrive') || segment.startsWith('google drive')) return 'Google Drive'
  if (segment.startsWith('box')) return 'Box'
  return null
}

function providerFromStandaloneSegment(segment: string): CloudSyncPathWarning['provider'] | null {
  if (segment === 'dropbox') return 'Dropbox'
  if (segment === 'onedrive' || segment.startsWith('onedrive - ')) return 'OneDrive'
  if (segment === 'google drive') return 'Google Drive'
  if (segment === 'box') return 'Box'
  return null
}
