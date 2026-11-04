import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' makes the built site work from any sub-path, e.g. https://USERNAME.github.io/REPO/
export default defineConfig({ plugins: [react()], base: './' });
