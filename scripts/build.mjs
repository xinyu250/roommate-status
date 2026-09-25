import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await copyFile('roommate-status.html', 'dist/roommate-status.html');
