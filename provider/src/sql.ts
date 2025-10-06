import { Client } from 'pg';
import type { DBProps, TriggerProps } from './types';

const withClient = async <T>(conn: string, fn: (c: Client) => Promise<T>): Promise<T> => {
  const client = new Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
};

const qIdent = (id: string) => `"${id.replace(/"/g, '""')}"`;

const splitQualifiedName = (qname: string): { schema: string; name: string } => {
  if (qname.includes('.')) {
    const [schema, name] = qname.split('.');
    if (!schema || !name) throw new Error(`Invalid table qualified name: "${qname}"`);
    return { schema, name };
  }

  return { schema: 'public', name: qname };
};

const sqlCreatePrerequisites = (roleName: string, namespace: string, lambdaInvokerFn: string) => `
  create extension if not exists pgcrypto;
  create extension if not exists aws_commons;
  create extension if not exists aws_lambda;

  do $$
  begin
    if not exists (select 1 from pg_roles where rolname = '${roleName}') then
      create role ${qIdent(roleName)} nologin;
    end if;
  end $$;

  grant usage on schema aws_lambda, aws_commons to ${qIdent(roleName)};
  grant execute on all functions in schema aws_lambda to ${qIdent(roleName)};
  grant execute on all functions in schema aws_commons to ${qIdent(roleName)};

  create schema if not exists ${qIdent(namespace)};

  create or replace function ${qIdent(namespace)}.${qIdent(lambdaInvokerFn)}()
  returns trigger
  language plpgsql
  security definer
  set search_path = ${qIdent(namespace)}, pg_temp
  as $$
  declare
    arn text := tg_argv[0];
    payload jsonb := jsonb_build_object(
      'type', tg_op,
      'schema', tg_table_schema,
      'table', tg_table_name,
      'record', case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) else null end,
      'old_record', case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) else null end
    );
  begin
    perform aws_lambda.invoke(aws_commons.create_lambda_function_arn(arn), payload::json, 'Event');
    return null; -- AFTER triggers may return null
  end;
  $$;

  alter function ${qIdent(namespace)}.${qIdent(lambdaInvokerFn)}() owner to ${qIdent(roleName)};
`;

const buildOps = (tr: TriggerProps) => {
  const ops: string[] = [];

  if (tr.insert) ops.push('INSERT');
  if (tr.delete) ops.push('DELETE');
  if (tr.update) {
    const cols = tr.update.columns;
    if (Array.isArray(cols) && cols.length > 0) {
      ops.push(`UPDATE OF ${cols.map((c) => qIdent(c)).join(', ')}`);
    } else if (typeof cols === 'string' && cols.trim()) {
      ops.push(`UPDATE OF ${qIdent(cols)}`);
    } else {
      ops.push('UPDATE');
    }
  }

  if (ops.length === 0) ops.push('INSERT', 'UPDATE', 'DELETE'); // default if user only set table/order/level
  return ops.join(' OR ');
};

const sqlCreateTrigger = (
  triggerName: string,
  tblSchema: string,
  tblName: string,
  tr: TriggerProps,
  namespace: string,
  dbFnName: string,
  targetArn: string,
) => {
  const order = tr.order ?? 'AFTER';
  const level = tr.level ?? 'ROW';

  if (order !== 'AFTER') throw new Error(`Only AFTER triggers are supported; got ${order}`);
  if (level !== 'ROW') throw new Error(`Only ROW triggers are supported; got ${level}`);

  const ops = buildOps(tr);
  const whenClause = ''; // extend if you add "when" support
  const arnLiteral = `'${String(targetArn).replace(/'/g, "''")}'`;

  return `
    drop trigger if exists ${qIdent(triggerName)} on ${qIdent(tblSchema)}.${qIdent(tblName)} cascade;
    create trigger ${qIdent(triggerName)}
    ${order} ${ops} on ${qIdent(tblSchema)}.${qIdent(tblName)}
    for each ${level.toLowerCase()}${whenClause}
    execute function ${qIdent(namespace)}.${qIdent(dbFnName)}(${arnLiteral});
  `;
};

const sqlDropTrigger = (triggerName: string, tblSchema: string, tblName: string) =>
  `drop trigger if exists ${qIdent(triggerName)} on ${qIdent(tblSchema)}.${qIdent(tblName)} cascade;`;

const lambdaNameFromArn = (arn: string) => {
  const marker = ':function:';
  const idx = arn.indexOf(marker);
  if (idx === -1) return arn.split(':').pop() || 'lambda';
  return arn.slice(idx + marker.length);
};

export const buildTriggerName = (namespace: string, targetArn: string) =>
  [namespace, lambdaNameFromArn(targetArn)].join('_');

export const ensurePrereqs = async (conn: string, db: DBProps) => {
  await withClient(conn, (c) =>
    c.query(sqlCreatePrerequisites(db.RoleName, db.Namespace, db.FunctionName)),
  );
};

export const createTrigger = async (
  conn: string,
  db: DBProps,
  trg: TriggerProps,
  targetArn: string,
  functionName: string,
) => {
  const { schema, name } = splitQualifiedName(trg.table);
  const triggerName = buildTriggerName(db.Namespace, functionName);
  const sql = sqlCreateTrigger(
    triggerName,
    schema,
    name,
    trg,
    db.Namespace,
    db.FunctionName,
    targetArn,
  );
  await withClient(conn, (c) => c.query(sql));
  return triggerName;
};

export const dropTrigger = async (
  conn: string,
  db: DBProps,
  trg: TriggerProps,
  functionName: string,
) => {
  const { schema, name } = splitQualifiedName(trg.table);
  const triggerName = buildTriggerName(db.Namespace, functionName);
  await withClient(conn, (c) => c.query(sqlDropTrigger(triggerName, schema, name)));
  return triggerName;
};
