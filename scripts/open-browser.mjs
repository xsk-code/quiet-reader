import { spawn } from 'node:child_process';

export function openBrowser(url) {
  if (process.argv.includes('--no-open')) return;
  const command = process.platform === 'darwin' ? ['open', url]
    : process.platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', 'start', '""', url]
    : ['xdg-open', url];
  const opener = spawn(command[0], command.slice(1), { stdio: 'ignore', windowsHide: true });
  opener.on('error', () => console.log(`请手动打开：${url}`));
  opener.unref();
}
