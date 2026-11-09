import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import type { Server as HttpServer } from 'node:http';
import { attachRelay } from './server/relay';

function sensorLab(): Plugin {
  return {
    name: 'rally-room-relay',
    configureServer(server) {
      if (server.httpServer) attachRelay(server.httpServer as unknown as HttpServer, '/ws');
      server.middlewares.use('/api/lan', (request, response, next) => {
        if (request.method !== 'GET' || request.url?.split('?')[0] !== '/') return next();
        const privateIp = (ip: string) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
        const ips = [...new Set(Object.values(networkInterfaces()).flatMap((entries) =>
          (entries ?? []).filter((entry) => entry.family === 'IPv4' && !entry.internal)
            .map((entry) => entry.address),
        ))].sort((a, b) => Number(privateIp(b)) - Number(privateIp(a)));
        const address = server.httpServer?.address();
        const port = address && typeof address === 'object' ? address.port : server.config.server.port;
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Cache-Control', 'no-store');
        response.end(JSON.stringify({ ips, port }));
      });
    },
  };
}

export default defineConfig({
  plugins: [basicSsl(), sensorLab()],
  server: { host: true, port: 5280, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        play: fileURLToPath(new URL('./play/index.html', import.meta.url)),
        lab: fileURLToPath(new URL('./lab/index.html', import.meta.url)),
      },
    },
  },
});
