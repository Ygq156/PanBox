import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Electron 以 file:// 加载构建产物，base 必须是相对路径
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome120',
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
