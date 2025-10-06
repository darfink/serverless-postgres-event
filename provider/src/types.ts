export type DBProps = {
  ConnectionString?: string;
  Namespace: string;
  RoleName: string;
  FunctionName: string;
};

export type TriggerProps = {
  table: string;
  update?: { columns?: string | string[] };
  delete?: { columns?: string | string[] };
  insert?: { columns?: string | string[] };
  order?: 'BEFORE' | 'AFTER';
  level?: 'ROW' | 'STATEMENT';
};