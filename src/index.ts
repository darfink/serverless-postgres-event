import assert from 'node:assert';
import { Client } from 'pg';
import type Serverless from 'serverless';
import type Plugin from 'serverless/classes/Plugin';
import { getLambdaArn, partitionFromRegion, qIdent, slugify, splitQualifiedName } from './helpers';

type Op = 'INSERT' | 'UPDATE' | 'DELETE';
type Order = 'BEFORE' | 'AFTER';
type Level = 'ROW' | 'STATEMENT';

type PostgresEvent = {
  table: string; // e.g., "public.events"
  operations: Op[];
  order?: Order; // default AFTER
  level?: Level; // default ROW
  when?: string; // optional SQL expression, e.g. "NEW.status = 'PUBLISHED'"
};

type FunctionWithPostgresEvent = { key: string; trigger: PostgresEvent; arn: string };

type CustomConfig = {
  connectionString?: string; // or use env PG_CONNECTION_STRING
  namespace?: string; // optional
  roleName?: string; // optional
  functionName?: string; // optional
};

class PostgresEventPlugin {
  readonly provider = 'aws';

  constructor(
    private serverless: Serverless,
    _options: Serverless.Options,
    private logging: Plugin.Logging,
  ) {
    this.serverless.configSchemaHandler.defineFunctionEvent('aws', 'postgres', {
      type: 'object',
      properties: {
        table: { type: 'string' },
        operations: {
          type: 'array',
          items: { enum: ['INSERT', 'UPDATE', 'DELETE'] },
          minItems: 1,
        },
        order: { enum: ['BEFORE', 'AFTER'], default: 'AFTER' },
        level: { enum: ['ROW', 'STATEMENT'], default: 'ROW' },
        when: { type: 'string' },
      },
      required: ['table', 'operations'],
      additionalProperties: false,
    });
  }

  hooks: Plugin.Hooks = {
    initialize: () => {
      assert(
        this.config.connectionString,
        'Missing Postgres connection string. Set custom.postgres.connectionString or PG_CONNECTION_STRING env var.',
      );
    },
    'after:deploy:deploy': () => this.applyTriggers(),
    'after:deploy:function:deploy': () => this.applyTriggers(),
    'before:remove:remove': () => this.dropTriggers(),
  };

  private get log() {
    return this.logging.log;
  }

  private get config(): Required<CustomConfig> {
    const config =
      (this.serverless.service.custom as { postgres?: CustomConfig } | undefined)?.postgres || {};

    const service = this.serverless.service.getServiceName();
    const stage = this.serverless.getProvider('aws').getStage();
    const segments = ['sls', service, stage];
    const namespace = config.namespace ?? slugify(segments.filter(Boolean).join('_'));

    // TODO: Support AWS credentials
    return {
      connectionString: config.connectionString ?? process.env.PG_CONNECTION_STRING ?? '',
      functionName: config.functionName ?? `lambda_invoker`,
      roleName: config.roleName ?? `${namespace}_lambda_invoker`,
      namespace,
    };
  }

  private async getFunctionsWithPostgresEvent(): Promise<FunctionWithPostgresEvent[]> {
    const provider = this.serverless.getProvider('aws');
    const accountId = await provider.getAccountId();

    const fns = [];
    for (const fnKey of this.serverless.service.getAllFunctions()) {
      const fn = this.serverless.service.getFunction(fnKey);
      const [match, ...rest] = fn.events.filter((ev) => 'postgres' in ev && ev.postgres);

      if (rest.length > 0) {
        throw new Error(
          `Function "${fnKey}" has ${rest.length + 1} postgres events; only one is supported per function.`,
        );
      }

      if (match) {
        assert(fn.name, `Function "${fnKey}" has no name.`);
        const arn = getLambdaArn(
          partitionFromRegion(provider.getRegion()),
          provider.getRegion(),
          accountId,
          fn.name,
        );

        // biome-ignore lint/suspicious/noExplicitAny: it's ok
        const trigger = (match as any).postgres as PostgresEvent;
        fns.push({ key: fnKey, trigger, arn });
      }
    }

    return fns;
  }

  private async ensureCoreSql(client: Client) {
    const { namespace, roleName, functionName } = this.config;

    const coreSql = `
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
		`.trim();

    await client.query(coreSql);
  }

  private buildTriggerName(fn: FunctionWithPostgresEvent) {
    const { namespace } = this.config;
    return [namespace, fn.key].join('_');
  }

  // Build SQL using the stable id
  private buildCreateTriggerSql(fn: FunctionWithPostgresEvent) {
    const { table, operations, order, level, when } = fn.trigger;

    if (order !== 'AFTER') {
      throw new Error(`Only AFTER triggers are supported; got "${order}" for table ${table}`);
    }

    if (level !== 'ROW') {
      throw new Error(`Only ROW triggers are supported; got "${level}" for table ${table}`);
    }

    const { schema: tblSchema, name: tblName } = splitQualifiedName(table);
    const { namespace } = this.config;

    const ops = operations.join(' OR ');
    const whenClause = when ? `\n  when (${when})` : '';
    const triggerName = this.buildTriggerName(fn);
    const argLiteral = `'${fn.arn.replace(/'/g, "''")}'`;

    return `
			drop trigger if exists ${qIdent(triggerName)} on ${qIdent(tblSchema)}.${qIdent(tblName)} cascade;
			create trigger ${qIdent(triggerName)}
				${order} ${ops} on ${qIdent(tblSchema)}.${qIdent(tblName)}
				for each ${level.toLowerCase()}${whenClause}
				execute function ${qIdent(namespace)}.${qIdent(this.config.functionName)}(${argLiteral});
		`.trim();
  }

  private buildDropTriggerSql(fn: FunctionWithPostgresEvent) {
    const { table } = fn.trigger;
    const { schema: tblSchema, name: tblName } = splitQualifiedName(table);
    const triggerName = this.buildTriggerName(fn);
    return `drop trigger if exists ${qIdent(triggerName)} on ${qIdent(tblSchema)}.${qIdent(tblName)} cascade;`;
  }

  private async withClient(fn: (client: Client) => Promise<void>): Promise<void> {
    const { connectionString } = this.config;

    if (!connectionString) {
      throw new Error(
        'Missing Postgres connection string. Set custom.postgres.connectionString or PG_CONNECTION_STRING env var.',
      );
    }

    const client = new Client({
      connectionString,
      // AWS RDS uses a self-signed certificate
      ssl: { rejectUnauthorized: false },
    });

    await client.connect();
    try {
      await fn(client);
    } finally {
      await client.end();
    }
  }

  async applyTriggers() {
    this.log.info('Applying RDS Postgres extensions, roles, function, and triggers...');

    await this.withClient(async (client) => {
      await this.ensureCoreSql(client);
      for (const fn of await this.getFunctionsWithPostgresEvent()) {
        this.log.info(
          `Creating trigger on ${fn.trigger.table} for [${fn.trigger.operations.join(', ')}]`,
        );
        await client.query(this.buildCreateTriggerSql(fn));
      }
    });

    this.log.info('All triggers created.');
  }

  async dropTriggers() {
    this.log.info('Dropping triggers...');

    await this.withClient(async (client) => {
      for (const fn of await this.getFunctionsWithPostgresEvent()) {
        this.log.info(
          `Dropping trigger on ${fn.trigger.table} for [${fn.trigger.operations.join(', ')}]`,
        );
        await client.query(this.buildDropTriggerSql(fn));
      }
    });

    this.log.info('All triggers dropped.');
  }
}

export default PostgresEventPlugin satisfies Plugin.PluginStatic;
