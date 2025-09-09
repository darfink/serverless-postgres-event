import assert from 'node:assert';

export const slugify = (input: string) =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

export const qIdent = (id: string) => `"${id.replace(/"/g, '""')}"`;

export const splitQualifiedName = (qname: string): { schema: string; name: string } => {
  if (qname.includes('.')) {
    const [schema, name] = qname.split('.');
    assert(schema);
    assert(name);
    return { schema, name };
  }

  return { schema: 'public', name: qname };
};

export const partitionFromRegion = (region: string) =>
  region.startsWith('cn-') ? 'aws-cn' : region.startsWith('us-gov-') ? 'aws-us-gov' : 'aws';

export const getLambdaArn = (
  partition: string,
  region: string,
  accountId: string,
  functionName: string,
) => `arn:${partition}:lambda:${region}:${accountId}:function:${functionName}`;