import { defineConfig } from 'vite';
import { cpSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';

const STATIC_DIRS = ['img', 'circuitjs', 'examples', 'audio'];
const STATIC_FILES = [
  'lab4-counter.txt',
  'lab4-traffic.txt',
  'lab4-full.txt',
  'Frequency_Counter.ino',
  'Frequency_Counter_NonBlocking.ino',
  'Frequency_Counter_WebSim.ino',
];

function copyStatic() {
  return {
    name: 'copy-static-assets',
    closeBundle() {
      const out = 'dist';
      mkdirSync(out, { recursive: true });
      for (const dir of STATIC_DIRS) {
        if (existsSync(dir)) cpSync(dir, join(out, dir), { recursive: true });
      }
      for (const file of STATIC_FILES) {
        if (existsSync(file)) cpSync(file, join(out, file));
      }
    },
  };
}

export default defineConfig({
  server: {
    port: 8080,
    open: false,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  plugins: [copyStatic()],
});
