import crypto from 'node:crypto';

export const getHash = (content: string) =>
  crypto.createHash('sha256').update(content).digest('hex');
