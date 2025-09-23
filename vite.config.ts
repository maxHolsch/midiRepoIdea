import path from 'path';
import { defineConfig, loadEnv } from 'vite';


export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        // Use default Vite dev port to play nicely with `vercel dev` proxy
        port: 5173,
        host: '0.0.0.0',
      },
      plugins: [],
      // Do not inline secrets into the client bundle.
      define: {},
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
