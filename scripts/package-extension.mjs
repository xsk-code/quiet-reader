import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

// Chrome loads the unpacked directory directly; this archive is for handoff and
// store upload. It contains runtime files only and uses fixed entry timestamps so
// the same content produces the same SHA-256.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = path.join(root, 'extension');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function localHeader(name, method, crc, compressed, uncompressed) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6); // names are UTF-8
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressed, 18);
  header.writeUInt32LE(uncompressed, 22);
  header.writeUInt16LE(Buffer.byteLength(name), 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralHeader(entry) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt16LE(DOS_TIME, 12);
  header.writeUInt16LE(DOS_DATE, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.payload.length, 20);
  header.writeUInt32LE(entry.data.length, 24);
  header.writeUInt16LE(Buffer.byteLength(entry.name), 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(entry.offset, 42);
  return header;
}

export function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = String(file.name);
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    if (!name || name.includes('\\') || name.startsWith('/') || name.split('/').includes('..')) throw new Error(`扩展包文件名无效：${name}`);
    const compressed = deflateRawSync(data, { level: 9 });
    const method = compressed.length < data.length ? 8 : 0;
    const payload = method === 8 ? compressed : data;
    const crc = crc32(data);
    const local = localHeader(name, method, crc, payload.length, data.length);
    const entry = { name, method, crc, data, payload, offset };
    const nameBuffer = Buffer.from(name, 'utf8');
    locals.push(local, nameBuffer, payload);
    centrals.push(centralHeader(entry), nameBuffer);
    offset += local.length + nameBuffer.length + payload.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, central, end]);
}

function extensionPath(name) {
  if (typeof name !== 'string' || !name || path.isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw new Error(`manifest 中的路径无效：${name}`);
  return path.join(directory, name);
}

export async function runtimeFiles() {
  const manifest = JSON.parse(await readFile(extensionPath('manifest.json'), 'utf8'));
  if (manifest.manifest_version !== 3) throw new Error('extension/manifest.json 必须是 Manifest V3。');
  if (manifest.version !== pkg.version) throw new Error(`扩展版本 ${manifest.version} 与 package.json ${pkg.version} 不一致，请先同步版本。`);
  if (manifest.background?.type !== 'module' || !manifest.background?.service_worker) throw new Error('扩展缺少模块化 service worker。');
  const names = new Set(['manifest.json']);
  for (const name of await readdir(directory)) if (/\.m?js$/.test(name)) names.add(name);
  const icons = new Set([
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
  ]);
  for (const icon of icons) names.add(icon);
  const files = [];
  for (const name of [...names].sort()) {
    const data = await readFile(extensionPath(name));
    files.push({ name, data });
  }
  return files;
}

export async function packageExtension({ out } = {}) {
  const files = await runtimeFiles();
  const target = path.resolve(out || path.join(root, 'release', `quiet-reader-extension-${pkg.version}.zip`));
  const zip = buildZip(files);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, zip);
  return { target, bytes: zip.length, hash: createHash('sha256').update(zip).digest('hex'), files: files.map(file => file.name) };
}

async function main() {
  const flag = process.argv.indexOf('--out');
  const out = flag >= 0 ? process.argv[flag + 1] : '';
  if (flag >= 0 && !out) throw new Error('--out 需要一个输出路径。');
  const result = await packageExtension({ ...(out ? { out } : {}) });
  const shown = result.target.startsWith(root + path.sep) ? path.relative(root, result.target) : result.target;
  console.log(`扩展包已生成：${shown}`);
  console.log(`包含：${result.files.join('、')}`);
  console.log(`大小：${result.bytes} 字节\nSHA-256：${result.hash}\n仅在本机生成，尚未上传或发布。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
