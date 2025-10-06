import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import type Serverless from 'serverless';
import type Plugin from 'serverless/classes/Plugin';
import { getFileHash } from './helpers';

const PLUGIN_NAME = 'serverless-postgres-event';

enum Order {
  Before = 'BEFORE',
  After = 'AFTER',
}

enum Level {
  Row = 'ROW',
  Statement = 'STATEMENT',
}

type PostgresEventTriggerDefinition = {
  table: string; // e.g., "public.events"
  update?: { columns: string | string[] };
  delete?: { columns: string | string[] };
  insert?: { columns: string | string[] };
  order?: Order; // default AFTER
  level?: Level; // default ROW
};

class PostgresEventPlugin {
  readonly provider = 'aws';
  readonly providerZipBasename = 'provider/dist/index.zip';

  constructor(
    private serverless: Serverless,
    _options: Serverless.Options,
    private logging: Plugin.Logging,
  ) {
    this.serverless.configSchemaHandler.defineCustomProperties({
      type: 'object',
      properties: {
        [PLUGIN_NAME]: {
          type: 'object',
          properties: {
            connectionString: { type: 'string' },
            namespace: { type: 'string' },
            roleName: { type: 'string' },
            functionName: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    });

    const properties = {
      columns: {
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
      },
    };

    this.serverless.configSchemaHandler.defineFunctionEvent('aws', 'postgres', {
      type: 'object',
      properties: {
        table: { type: 'string' },
        update: { type: 'object', properties },
        delete: { type: 'object', properties },
        insert: { type: 'object', properties },
        order: { enum: Object.values(Order), default: Order.After },
        level: { enum: Object.values(Level), default: Level.Row },
      },
      required: ['table'],
      additionalProperties: false,
    });
  }

  hooks: Plugin.Hooks = {
    'before:package:initialize': () => this.prepareProviderZip(),
    'package:compileEvents': () => this.compilePostgresEvents(),
  };

  private get log() {
    return this.logging.log;
  }

  private get config() {
    return this.serverless.service.custom?.[PLUGIN_NAME] ?? {};
  }

  private async prepareProviderZip() {
    this.log.info('Preparing provider zip...');
    const { serviceDir } = this.serverless;
    const outDir = path.join(serviceDir, this.serverless.service.package.artifactDirectoryName);
    await fs.mkdir(outDir, { recursive: true });

    const src = require.resolve(`${PLUGIN_NAME}/assets/provider.zip`);
    const dst = path.join(outDir, this.providerZipBasename);
    await fs.copyFile(src, dst);
  }

  private async compilePostgresEvents() {
    this.log.info('Compiling Postgres events...');

    const commonProperties = {
      ProviderCodeHash: await getFileHash(require.resolve(`${PLUGIN_NAME}/assets/provider.zip`)),
      Database: {
        ConnectionString: this.config.connectionString,
        Namespace: this.config.namespace,
        RoleName: this.config.roleName,
        FunctionName: this.config.functionName,
      },
    };

    const provider = this.serverless.getProvider('aws');
    const cfTemplate = this.serverless.service.provider.compiledCloudFormationTemplate;
    const providerFnLogicalId = this.ensureProviderResources();

    // 1) Shared prerequisites CR
    const prereqId = 'PostgresPrerequisites';
    cfTemplate.Resources[prereqId] = {
      Type: 'Custom::PostgresPrerequisites',
      DependsOn: [providerFnLogicalId],
      Properties: {
        ServiceToken: { 'Fn::GetAtt': [providerFnLogicalId, 'Arn'] },
        ServiceType: 'Prerequisites',
        ...commonProperties,
      },
    };

    for (const functionName of this.serverless.service.getAllFunctions()) {
      const functionConfig = this.serverless.service.getFunction(functionName);
      const functionPostgresEvents = functionConfig.events
        .map((ev) => ('postgres' in ev ? ev.postgres : undefined))
        .filter((ev): ev is PostgresEventTriggerDefinition => ev !== undefined);

      if (functionPostgresEvents.length === 0) {
        continue;
      }

      const [postgresEvent] = functionPostgresEvents; // TODO: Support multiple postgres events per function
      const functionLogicalId = provider.naming.getLambdaLogicalId?.(functionName);
      const crId = `${provider.naming.getNormalizedFunctionName?.(functionName)}PostgresTrigger`;

      assert(functionLogicalId, `Failed to resolve logical ID for function "${functionName}".`);
      assert(crId, `Unable to resolve postgres trigger logical ID for function "${functionName}".`);

      cfTemplate.Resources[crId] = {
        Type: 'Custom::PostgresTrigger',
        DependsOn: [prereqId, providerFnLogicalId, functionLogicalId],
        Properties: {
          ServiceToken: { 'Fn::GetAtt': [providerFnLogicalId, 'Arn'] },
          ServiceType: 'Trigger',
          TargetArn: { 'Fn::GetAtt': [functionLogicalId, 'Arn'] },
          Trigger: postgresEvent,
          ...commonProperties,
        },
      };
    }
  }

  private ensureProviderResources(): string {
    const aws = this.serverless.getProvider('aws');
    const naming = aws.naming;
    const template = this.serverless.service.provider.compiledCloudFormationTemplate;
    const s3Key = `${this.serverless.service.package.artifactDirectoryName}/${this.providerZipBasename}`;

    // IAM role for the provider Lambda
    const roleId = 'PostgresProviderRole';
    template.Resources[roleId] ??= {
      Type: 'AWS::IAM::Role',
      Properties: {
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { Service: ['lambda.amazonaws.com'] },
              Action: ['sts:AssumeRole'],
            },
          ],
        },
        Policies: [
          {
            PolicyName: `${aws.getStage()}-${this.serverless.service.getServiceName()}-postgres-provider`,
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: [
                {
                  Effect: 'Allow',
                  Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
                  Resource: '*',
                },
              ],
            },
          },
        ],
      },
    };

    // Provider Lambda using the copied zip; Serverless uploads it to the deployment bucket
    const bucketId = naming.getDeploymentBucketLogicalId?.();
    assert(bucketId, `Failed to resolve logical ID for deployment bucket.`);

    const fnId = 'PostgresProviderLambdaFunction';
    template.Resources[fnId] = {
      Type: 'AWS::Lambda::Function',
      DependsOn: [roleId],
      Properties: {
        Runtime: 'nodejs22.x',
        Handler: 'index.handler',
        Role: { 'Fn::GetAtt': [roleId, 'Arn'] },
        Timeout: 60,
        MemorySize: 256,
        Code: {
          S3Bucket: { Ref: bucketId },
          S3Key: s3Key,
        },
      },
    };

    // Optional CW Logs group (mirrors Serverless style)
    const logGroupId = naming.getLogGroupLogicalId?.('PostgresProvider');
    const logGroupName = naming.getLogGroupName?.(
      `${this.serverless.service.getServiceName()}-${aws.getStage()}-PostgresProvider`,
    );
    const logRetentionInDays =
      'getLogRetentionInDays' in aws && typeof aws.getLogRetentionInDays === 'function'
        ? aws.getLogRetentionInDays?.()
        : 30;

    assert(logGroupId, `Failed to resolve logical ID for log group.`);
    assert(logGroupName, `Failed to resolve log group name.`);

    template.Resources[logGroupId] = {
      Type: 'AWS::Logs::LogGroup',
      Properties: {
        LogGroupName: logGroupName,
        RetentionInDays: logRetentionInDays,
      },
    };

    return fnId;
  }
}

export default PostgresEventPlugin satisfies Plugin.PluginStatic;
