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

  const res = await fetch(event.ResponseURL, { method: 'PUT', body: JSON.stringify(body) });

  if (!res.ok) {
    throw new Error(`CFN response PUT failed: ${res.status} ${res.statusText}`);
  }
};

export const handler: CloudFormationCustomResourceHandler<ResourceProperties> = async (event) => {
  let physId = null;

  try {
    const props = event.ResourceProperties;

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

        switch (event.RequestType) {
          case 'Create':
          case 'Update': {
            await ensurePrereqs(conn, props.Database);
            await respond(event, { PhysicalResourceId: physId });
            break;
          }
          case 'Delete': {
            // No-op; leave extensions/role/schema or add cleanup if desired
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

        switch (event.RequestType) {
          case 'Create': {
            await createTrigger(newConn, newDb, trg, targetArn);
            await respond(event, { PhysicalResourceId: physId });
            break;
          }
          case 'Update': {
            // If DB connection changed, drop in old DB first
            const oldDb = event.OldResourceProperties.Database;
            const oldConn = oldDb.ConnectionString;

            if (oldConn && oldConn !== newConn) {
              await dropTrigger(oldConn, oldDb, trg, targetArn).catch((e) =>
                console.log('Drop trigger in old DB failed (ignored):', (e as Error).message),
              );
            } else {
              await dropTrigger(newConn, newDb, trg, targetArn).catch((e) =>
                console.log('Drop trigger in new DB failed (ignored):', (e as Error).message),
              );
            }

            await createTrigger(newConn, newDb, trg, targetArn);
            await respond(event, { PhysicalResourceId: physId });
            break;
          }
          case 'Delete': {
            await dropTrigger(newConn, newDb, trg, targetArn).catch((e) =>
              console.log('Drop trigger on delete failed (ignored):', (e as Error).message),
            );
            await respond(event, { PhysicalResourceId: physId });
            break;
          }
        }
        break;
      }
    }
  } catch (err) {
    await respond(event, { PhysicalResourceId: physId!, Error: String(err) }).catch(() => {});
    throw err;
  }
};
