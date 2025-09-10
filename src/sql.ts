import { qIdent } from './helpers';

export const sqlCreatePrerequisites = (
  roleName: string,
  namespace: string,
  functionName: string,
) => `
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

  create or replace function ${qIdent(namespace)}.${qIdent(functionName)}()
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

  alter function ${qIdent(namespace)}.${qIdent(functionName)}() owner to ${qIdent(roleName)};
  `;

export const sqlCreateTrigger = (
  triggerName: string,
  tblSchema: string,
  tblName: string,
  order: string,
  ops: string,
  level: string,
  whenClause: string,
  namespace: string,
  functionName: string,
  functionArn: string,
) => `
    drop trigger if exists ${qIdent(triggerName)} on ${qIdent(tblSchema)}.${qIdent(tblName)} cascade;
    create trigger ${qIdent(triggerName)}
    ${order} ${ops} on ${qIdent(tblSchema)}.${qIdent(tblName)}
    for each ${level.toLowerCase()}${whenClause}
    execute function ${qIdent(namespace)}.${qIdent(functionName)}(${functionArn});
  `;

export const sqlDropTrigger = (triggerName: string, tblSchema: string, tblName: string) =>
  `drop trigger if exists ${qIdent(triggerName)} on ${qIdent(tblSchema)}.${qIdent(tblName)} cascade;`;
