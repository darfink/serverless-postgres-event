import type {
  CloudFormationCustomResourceEvent,
  CloudFormationCustomResourceHandler,
  CloudFormationCustomResourceResponse,
} from 'aws-lambda';
import { buildTriggerName, createTrigger, dropTrigger, ensurePrereqs } from './sql';
import type { DBProps, TriggerProps } from './types';

type ResourceProperties = { Database: DBProps } & (
  | { ServiceType: 'Prerequisites' }
  | { ServiceType: 'Trigger'; Trigger: TriggerProps; TargetArn: string }
);

const respond = async (
  event: CloudFormationCustomResourceEvent<ResourceProperties>,
  data: { PhysicalResourceId: string; Error?: string },
) => {
  const body: CloudFormationCustomResourceResponse = {
    Status: data.Error ? 'FAILED' : 'SUCCESS',
    Reason: 'See CloudWatch Logs for details',
    PhysicalResourceId: data.PhysicalResourceId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    NoEcho: false,
    Data: data,
    ...(data.Error ? { Error: data.Error } : {}),
  };

  console.log(
    `📤 Sending CFN response: status=${body.Status} physicalId=${body.PhysicalResourceId}`,
  );
  const res = await fetch(event.ResponseURL, { method: 'PUT', body: JSON.stringify(body) });

  if (!res.ok) {
    throw new Error(`CFN response PUT failed: ${res.status} ${res.statusText}`);
  }
  console.log('✅ CFN response delivered');
};

export const handler: CloudFormationCustomResourceHandler<ResourceProperties> = async (event) => {
  let physId = null;

  try {
    const props = event.ResourceProperties;
    console.log(`📨 Event received: requestType=${event.RequestType} service=${props.ServiceType}`);

    switch (props.ServiceType) {
      case 'Prerequisites': {
        const conn = props.Database.ConnectionString || process.env.PG_CONNECTION_STRING || '';

        if (!conn) {
          throw new Error('Missing Database.ConnectionString');
        }

        physId =
          event.RequestType === 'Create'
            ? props.Database.Namespace
            : event.PhysicalResourceId || props.Database.Namespace;
        console.log(
          `🧩 Prerequisites physicalId computed: ${physId} (namespace=${props.Database.Namespace})`,
        );

        switch (event.RequestType) {
          case 'Create':
          case 'Update': {
            console.log(
              `🔧 Ensuring prerequisites: role=${props.Database.RoleName} namespace=${props.Database.Namespace} fn=${props.Database.FunctionName}`,
            );
            await ensurePrereqs(conn, props.Database);
            console.log('✅ Prerequisites ensured');
            await respond(event, { PhysicalResourceId: physId });
            break;
          }
          case 'Delete': {
            // No-op; leave extensions/role/schema or add cleanup if desired
            console.log(
              `🧹 Prerequisites delete requested for namespace=${props.Database.Namespace} (no-op)`,
            );
            await respond(event, { PhysicalResourceId: physId });
            break;
          }
        }
        break;
      }

      case 'Trigger': {
        const trg = props.Trigger;
        const targetArn = props.TargetArn;

        if (!targetArn) throw new Error('Missing TargetArn');

        const newDb = props.Database;
        const newConn = newDb.ConnectionString || process.env.PG_CONNECTION_STRING || '';

        if (!newConn) throw new Error('Missing Database.ConnectionString');

        // Stable physical id based on namespace + lambda name
        physId = buildTriggerName(newDb.Namespace, targetArn);
        console.log(
          `🧩 Trigger physicalId computed: ${physId} (table=${trg.table} namespace=${newDb.Namespace})`,
        );

        switch (event.RequestType) {
          case 'Create': {
            console.log(
              `🛠️ Creating trigger on table=${trg.table} for targetArn=...${targetArn.slice(-16)}`,
            );
            await createTrigger(newConn, newDb, trg, targetArn);
            console.log(`✅ Trigger created: ${physId}`);
            await respond(event, { PhysicalResourceId: physId });
            break;
          }
          case 'Update': {
            // If DB connection changed, drop in old DB first
            const oldDb = event.OldResourceProperties.Database;
            const oldConn = oldDb.ConnectionString;

            if (oldConn && oldConn !== newConn) {
              console.log('🔁 Connection changed; dropping trigger in old DB before recreate');
              await dropTrigger(oldConn, oldDb, trg, targetArn).catch((e) =>
                console.warn('⚠️ Drop trigger in old DB failed (ignored):', (e as Error).message),
              );
            } else {
              console.log('🔁 Dropping existing trigger in current DB before update');
              await dropTrigger(newConn, newDb, trg, targetArn).catch((e) =>
                console.warn('⚠️ Drop trigger in current DB failed (ignored):', (e as Error).message),
              );
            }

            console.log(
              `🛠️ Recreating trigger on table=${trg.table} for targetArn=...${targetArn.slice(-16)}`,
            );
            await createTrigger(newConn, newDb, trg, targetArn);
            console.log(`✅ Trigger updated: ${physId}`);
            await respond(event, { PhysicalResourceId: physId });
            break;
          }
          case 'Delete': {
            console.log(
              `🗑️ Deleting trigger on table=${trg.table} for targetArn=...${targetArn.slice(-16)}`,
            );
            await dropTrigger(newConn, newDb, trg, targetArn).catch((e) =>
              console.warn('⚠️ Drop trigger on delete failed (ignored):', (e as Error).message),
            );
            console.log(`✅ Trigger deleted (if existed): ${physId}`);
            await respond(event, { PhysicalResourceId: physId });
            break;
          }
        }
        break;
      }
    }
  } catch (err) {
    console.error('❌ Handler error:', err);
    await respond(event, { PhysicalResourceId: physId!, Error: String(err) }).catch(() => {});
    throw err;
  }
};
