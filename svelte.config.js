import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

/** @type {import('@sveltejs/vite-plugin-svelte').SvelteConfig} */
export default {
  compilerOptions: {
    // Force Svelte 5 runes mode. Required for svelte-check to process
    // $state, $derived, $effect as runes rather than legacy store syntax.
    runes: true,
  },
  preprocess: vitePreprocess()
}
