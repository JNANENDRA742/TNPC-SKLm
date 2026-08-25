import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/tools/
export default defineConfig({
  plugins: [react(), tailwindcss()],

  server: {
    host: true,
    // Allow the sandbox preview host (dev-only; production builds unaffected)
    allowedHosts: true,
    // Dev-only proxy: lets the frontend call the backend with relative URLs
    // (used when VITE_BACKEND_URL is left empty, e.g. in sandboxed previews).
    // Has NO effect on production builds / Vercel.
    proxy: {
      '/login': 'http://localhost:5000',
      '/signup': 'http://localhost:5000',
      '/forgot-password': 'http://localhost:5000',
      '/verify-otp': 'http://localhost:5000',
      '/reset-password': 'http://localhost:5000',
      '/socket.io': { target: 'http://localhost:5000', ws: true }
    }
  }
})
