## serverless-postgres-event

Trigger AWS Lambda functions from PostgreSQL (RDS/Aurora) using Serverless Framework events. This plugin creates a Postgres trigger that sends row-change payloads to your Lambda via the `aws_lambda` extension.

### Features
- **Events**: `INSERT`, `UPDATE`, `DELETE`
- **Scope**: Only `AFTER ROW` triggers (with optional `WHEN` predicate)
- **Lifecycle**: Triggers are created after deploy and dropped before remove
- **Payload**: Sends `type`, `schema`, `table`, `record`, and `old_record` as JSON

---

## Requirements

- Serverless Framework v3
- PostgreSQL with extensions: `pgcrypto`, `aws_commons`, `aws_lambda`
- Your DB instance/cluster must be allowed to invoke Lambda (via an IAM role with `lambda:InvokeFunction`). See AWS docs: [Integrating Amazon Aurora PostgreSQL with AWS Lambda](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.Integrating.AWSLambda.html)
- The database user in your `connectionString` must be able to:
  - `CREATE EXTENSION` (or the extensions must already exist)
  - `CREATE SCHEMA` and `CREATE FUNCTION`
  - `GRANT` execute/usage on the `aws_lambda` and `aws_commons` schemas

---

## Install

### From npm (recommended when published)
```bash
pnpm add -D serverless-postgres-event
# or
npm i -D serverless-postgres-event
```

### From GitHub
- If the repo commits `dist/`, install directly:
```bash
pnpm add -D your-org/serverless-postgres-event#v0.1.0
# or
npm i -D your-org/serverless-postgres-event#main
```
- If the repo does NOT commit `dist/`, it should include a `"prepare": "tsc"` script so install from Git can build TypeScript on install. Make sure lifecycle scripts are allowed in your environment.

---

## Usage

### 1) Add the plugin
```yaml
# serverless.yml
plugins:
  - serverless-postgres-event
```

### 2) Configure Postgres (global)
```yaml
# serverless.yml
custom:
  postgres:
    # Either set the connection string here...
    # connectionString: postgres://user:pass@host:5432/dbname
    # ...or via environment variable:
    # PG_CONNECTION_STRING=postgres://user:pass@host:5432/dbname

    # Optional overrides:
    # namespace: sls_${self:service}_${sls:stage}     # default: slugified "sls_<service>_<stage>"
    # roleName: ${self:custom.postgres.namespace}_lambda_invoker
    # functionName: lambda_invoker
```

- At initialization, the plugin asserts a connection string exists (either `custom.postgres.connectionString` or `PG_CONNECTION_STRING` env var).
- The plugin will:
  - Ensure `pgcrypto`, `aws_commons`, `aws_lambda` extensions exist
  - Create schema `${namespace}` if not present
  - Create a SQL function `${namespace}.${functionName}()` (owned by `${roleName}`)
  - Grant required usage/execute permissions to `${roleName}`

### 3) Add the `postgres` event to your functions
```yaml
functions:
  onEventChange:
    handler: src/handler.main
    events:
      - postgres:
          table: public.events
          operations: [INSERT, UPDATE, DELETE]  # at least one required
          order: AFTER                           # only AFTER supported
          level: ROW                             # only ROW supported
          when: "NEW.status = 'PUBLISHED'"       # optional SQL predicate
```

- Only one `postgres` event is supported per function.
- Triggers are created:
  - After full deploy: `after:deploy:deploy`
  - After single function deploy: `after:deploy:function:deploy`
- Triggers are dropped:
  - Before remove: `before:remove:remove`

---

## Event payload (to your Lambda)

The plugin invokes your Lambda with a JSON payload like:
```json
{
  "type": "INSERT",
  "schema": "public",
  "table": "events",
  "record": { "...": "new row (for INSERT/UPDATE)" },
  "old_record": { "...": "old row (for UPDATE/DELETE)" }
}
```

Example handler (TypeScript):
```ts
export const main = async (event: {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  schema: string;
  table: string;
  record: Record<string, unknown> | null;
  old_record: Record<string, unknown> | null;
}) => {
  // Your logic here
  console.log(event);
};
```

---

## How it works

- The plugin scans functions for `postgres` events and computes each function’s ARN from the current AWS account/region.
- It creates a Postgres trigger per event that calls `${namespace}.${functionName}('<lambda-arn>')`.
- The SQL function calls `aws_lambda.invoke(...)` with the JSON payload (event type + row data).

---

## Limitations

- Only `AFTER ROW` triggers are supported.
- One `postgres` event per function.
- The DB instance/cluster must be permitted to call your Lambda (IAM role + policy).
- Multi-region or cross-account requires the ARN to be resolvable in the target account/region used by Serverless.

---

## Development

- Build: `pnpm build` (runs `tsc`, outputs to `dist/`)
- Optional type declarations: enable `declaration` in `tsconfig` and add `"types": "dist/index.d.ts"` to `package.json`.
- For GitHub installs without published npm package, add:
```json
{
  "scripts": { "prepare": "tsc" }
}
```

---

## License

ISC
