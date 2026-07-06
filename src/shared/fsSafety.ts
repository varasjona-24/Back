import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

export function isPathInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);

  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function ensureDirForFile(filePath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
}

export async function cleanupFile(filePath?: string): Promise<void> {
  if (!filePath) return;
  await fs.promises.unlink(filePath).catch(() => {});
}

export async function cleanupDir(dirPath?: string): Promise<void> {
  if (!dirPath) return;
  await fs.promises.rm(dirPath, { recursive: true, force: true }).catch(() => {});
}

export async function cleanupTempArtifact(filePath?: string): Promise<void> {
  if (!filePath) return;

  const resolvedFile = path.resolve(filePath);
  const tmpRoot = path.resolve(process.cwd(), 'tmp');
  const parentDir = path.dirname(resolvedFile);

  await cleanupFile(resolvedFile);

  if (!isPathInsideRoot(tmpRoot, parentDir)) return;
  const parentName = path.basename(parentDir);
  if (!/^(mega-audio|mega-video)-/.test(parentName)) return;

  await fs.promises.rmdir(parentDir).catch(() => {});
}

export function randomTmpFilePath(prefix: string, extension: string): string {
  const tmpDir = path.resolve(process.cwd(), 'tmp');
  const safePrefix = prefix.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  const safeExtension = extension.replace(/^\.+/, '').replace(/[^a-z0-9]/gi, '');

  return path.join(tmpDir, `${safePrefix}-${randomUUID()}.${safeExtension || 'bin'}`);
}
