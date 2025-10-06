import crypto from 'node:crypto';

export const getHash = (content: string) =>
  crypto.createHash('sha256').update(content).digest('hex');

export const slugify = (input: string) =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');