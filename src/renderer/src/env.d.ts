/// <reference types="svelte" />

import type { ManifestAPI } from '../../shared/ipc'

declare global {
  interface Window {
    api: ManifestAPI
  }
}

export {}
