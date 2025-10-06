import crypto from 'node:crypto';
import fs from 'node:fs/promises';

export const getFileHash = async (filePath: string) => {
  const file = await fs.readFile(filePath, 'utf8');
  return crypto.createHash('sha256').update(file).digest('hex');
};