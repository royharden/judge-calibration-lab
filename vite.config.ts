import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Plain SPA build. No server proxy, no env injection beyond Vite's VITE_* convention
// (only VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are ever read by the browser).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
