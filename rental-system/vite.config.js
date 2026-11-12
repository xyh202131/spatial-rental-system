import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rolldownOptions: {
      input: {
        landlord: resolve(import.meta.dirname, 'index.html'),
        tenant: resolve(import.meta.dirname, 'tenant.html'),
      },
    },
  },
});
