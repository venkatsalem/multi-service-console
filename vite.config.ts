import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Content Security Policy for the packaged renderer. Only applied to builds:
// the Vite dev server needs inline scripts and a websocket for HMR.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'msc-content-security-policy',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content: CONTENT_SECURITY_POLICY
          },
          injectTo: 'head-prepend'
        }
      ];
    }
  };
}

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  server: {
    port: 5174,
    strictPort: true
  }
});
