import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const run = promisify(execFile);
try {
  const { stdout: status } = await run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root });
  if (status.trim()) throw new Error('工作区尚未提交完成，请先审查并提交源码，再生成当前 HEAD 的快照。');
  const { stdout } = await run('git', ['ls-files', '-z'], { cwd: root });
  const files = stdout.split('\0').filter(Boolean);
  const forbidden = files.filter(file => /^(?:data|node_modules|release|\.aws|\.codex|\.agents)\//.test(file)
    || /(?:^|\/)secrets\.json$/.test(file)
    || /^\.env(?:\..*)?$/.test(file) && file !== '.env.example'
    || /(?:\.log|\.DS_Store)$/.test(file));
  if (forbidden.length) throw new Error('跟踪文件中存在数据、环境或日志内容，请先人工检查并移出源码版本。');
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'CHANGELOG.md', 'public/fonts/pt-serif/OFL.txt', 'AGENTS.md', 'README.en.md', 'llms.txt', 'docs/PROVIDERS.md', 'docs/RELEASE_CHECKLIST.md', 'docs/RELEASE_NOTES_0.1.0.md']) await access(path.join(root, file));
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (pkg.license !== 'MIT' || !/^[\w.-]+$/.test(pkg.name) || !/^[\w.-]+$/.test(pkg.version)) throw new Error('发布元数据无效。');
  const directory = path.join(root, 'release'); await mkdir(directory, { recursive: true });
  const filename = path.join(directory, `${pkg.name}-${pkg.version}-source.tar.gz`);
  await run('git', ['archive', '--format=tar.gz', `--prefix=${pkg.name}-${pkg.version}/`, `--output=${filename}`, 'HEAD'], { cwd: root });
  const hash = createHash('sha256').update(await readFile(filename)).digest('hex');
  console.log(`源码快照已生成：${filename}\nSHA-256：${hash}\n仅包含当前 HEAD 的源码，不包含 Git 历史；尚未上传或发布。`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
