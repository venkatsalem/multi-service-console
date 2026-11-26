import fs from 'fs';
import path from 'path';

/**
 * Write a file by writing a temp file next to it and renaming it into place,
 * so a crash or power loss mid-write cannot leave a truncated config behind.
 */
export function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  try {
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Windows can refuse the rename while the target is briefly locked
    // (antivirus, an editor holding the file); fall back to an in-place write.
    try {
      fs.writeFileSync(filePath, content, 'utf8');
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Ignore temp cleanup failure
      }
    }
  }
}

/** Copy an unreadable file aside so it is not lost when the app later saves over it. */
export function backupUnreadableFile(filePath: string): string | null {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${filePath}.corrupt-${stamp}.bak`;
  try {
    fs.copyFileSync(filePath, backupPath);
    return backupPath;
  } catch {
    return null;
  }
}
