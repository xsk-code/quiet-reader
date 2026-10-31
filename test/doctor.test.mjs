import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const run = (args, env) => new Promise(resolve => {
  const child = spawn(process.execPath, ['scripts/doctor.mjs', '--json', ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('close', code => resolve({ code, stdout, stderr }));
});

test('doctor separates a healthy install from an unconfigured model', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'quiet-reader-doctor-'));
  try {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('READER_')) delete env[key];
    Object.assign(env, { READER_DATA_DIR: directory, READER_TEXT_PROVIDER: 'codex', READER_IMAGE_PROVIDER: 'none',
      READER_API_BASE_URL: '', READER_TEXT_MODEL: '', READER_IMAGE_API_BASE_URL: '', READER_IMAGE_MODEL: '',
      READER_API_KEY: '', READER_IMAGE_API_KEY: '', PORT: '4317', IMAGE_CONCURRENCY: '2',
      AGY_BIN: path.join(directory, 'no-agy'), CODEX_BIN: path.join(directory, 'no-codex') });
    const report = await run([], env);
    assert.equal(report.code, 0, report.stderr);
    const value = JSON.parse(report.stdout);
    assert.equal(value.ok, true); assert.equal(value.ready, false);
    assert.equal(value.checks.find(check => check.name === 'text').status, 'warning');
    const required = await run(['--require-model'], env);
    assert.equal(required.code, 1);
    const strict = JSON.parse(required.stdout);
    assert.equal(strict.ok, false); assert.equal(strict.ready, false);
    assert.equal(strict.checks.find(check => check.name === 'model').status, 'error');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
