import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/renderer/index.html'),
        audio: resolve(__dirname, 'src/renderer/audio.html'),
        overlay: resolve(__dirname, 'src/renderer/overlay.html'),
        sdt: resolve(__dirname, 'src/renderer/sdt.html'),
        suggestions: resolve(__dirname, 'src/renderer/suggestions.html'),
      },
    },
  },
})
