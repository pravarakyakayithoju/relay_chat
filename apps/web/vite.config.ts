import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the browser talks only to Vite (http://localhost:5173), and
// Vite forwards API calls and the WebSocket to the backend services. That
// mirrors production, where Nginx does the same job, so the app never needs
// to know backend addresses and there are no cross-origin (CORS) issues.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.API_URL ?? 'http://localhost:3000', changeOrigin: true },
      '/ws': { target: process.env.GATEWAY_URL ?? 'http://localhost:4000', ws: true },
    },
  },
});
