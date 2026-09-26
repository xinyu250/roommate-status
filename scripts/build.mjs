import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
const files = [
  'roommate-status.html',
  'manifest.json',
  'sw.js',
  'icon-192.png',
  'icon-512.png',
];
for (const file of files) {
  await copyFile(file, `dist/${file}`);
}
