// A reader of OpenAPI 3 and Swagger 2 documents (FR-3.3), JSON or YAML: endpoints with their methods, summaries,
// parameters, auth schemes, and the names of the request and response bodies. Anything else stays in the file.
import { parse as parseYaml } from 'yaml';

export interface ApiEndpoint {
  method: string;
  path: string;
  summary?: string;
  operationId?: string;
  tags?: string[];
  parameters: string[];
  requestBody?: string;
  responses: string[];
  auth?: string[];
}

export interface ApiStructure {
  kind: 'openapi';
  version: string;
  title?: string;
  servers: string[];
  auth: { name: string; type: string; scheme?: string }[];
  endpoints: ApiEndpoint[];
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {});
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

function schemaName(schema: unknown): string | undefined {
  const s = obj(schema);
  const ref = str(s.$ref);
  if (ref) return ref.split('/').at(-1);
  if (str(s.type) === 'array') return `${schemaName(s.items) ?? 'item'}[]`;
  return str(s.type);
}

function bodyName(content: unknown): string | undefined {
  const types = obj(content);
  const first = Object.values(types)[0];
  return first ? schemaName(obj(first).schema) : undefined;
}

export function parseOpenApi(text: string): ApiStructure | undefined {
  let doc: unknown;
  try {
    doc = text.trim().startsWith('{') ? JSON.parse(text) : parseYaml(text);
  } catch {
    return undefined;
  }
  const root = obj(doc);
  const version = str(root.openapi) ?? str(root.swagger);
  if (!version || !root.paths) return undefined;
  const info = obj(root.info);
  const host = str(root.host);
  const scheme = Array.isArray(root.schemes) ? str(root.schemes[0]) ?? 'https' : 'https';
  const servers = Array.isArray(root.servers) ? root.servers.map((server) => str(obj(server).url) ?? '').filter(Boolean) : host ? [`${scheme}://${host}${str(root.basePath) ?? ''}`] : [];
  const schemes = { ...obj(obj(root.components).securitySchemes), ...obj(root.securityDefinitions) };
  const auth = Object.entries(schemes).map(([name, scheme]) => ({ name, type: str(obj(scheme).type) ?? 'unknown', ...(str(obj(scheme).scheme) ? { scheme: str(obj(scheme).scheme) } : {}) }));
  const globalSecurity = Array.isArray(root.security) ? root.security.flatMap((item) => Object.keys(obj(item))) : [];
  const endpoints: ApiEndpoint[] = [];
  for (const [path, item] of Object.entries(obj(root.paths))) {
    const pathItem = obj(item);
    const pathParameters: unknown[] = Array.isArray(pathItem.parameters) ? (pathItem.parameters as unknown[]) : [];
    for (const method of METHODS) {
      const operation = obj(pathItem[method]);
      if (Object.keys(operation).length === 0) continue;
      const ownParameters: unknown[] = Array.isArray(operation.parameters) ? (operation.parameters as unknown[]) : [];
      const parameters = [...pathParameters, ...ownParameters].map((parameter) => {
        const p = obj(parameter);
        return `${str(p.name) ?? '?'}${p.required === true ? '' : '?'} (${str(p.in) ?? 'param'})`;
      });
      const responses = Object.entries(obj(operation.responses)).map(([code, response]) => `${code}${bodyName(obj(response).content) ? `: ${bodyName(obj(response).content)}` : str(obj(response).description) ? `: ${str(obj(response).description)}` : ''}`);
      const security = Array.isArray(operation.security) ? operation.security.flatMap((entry) => Object.keys(obj(entry))) : globalSecurity;
      const body = bodyName(obj(operation.requestBody).content) ?? schemaName(obj(ownParameters.find((parameter) => str(obj(parameter).in) === 'body')).schema);
      endpoints.push({
        method: method.toUpperCase(),
        path,
        ...(str(operation.summary) ? { summary: str(operation.summary) } : {}),
        ...(str(operation.operationId) ? { operationId: str(operation.operationId) } : {}),
        ...(Array.isArray(operation.tags) ? { tags: operation.tags.map(String) } : {}),
        parameters,
        ...(body ? { requestBody: body } : {}),
        responses,
        ...(security.length > 0 ? { auth: security } : {}),
      });
    }
  }
  return { kind: 'openapi', version, ...(str(info.title) ? { title: str(info.title) } : {}), servers, auth, endpoints };
}

/** A readable summary of the structure, appended to the document's text so endpoints are searchable. */
export function describeApi(api: ApiStructure): string {
  const lines = [`# ${api.title ?? 'API'} (${api.version.startsWith('2') ? 'Swagger' : 'OpenAPI'} ${api.version})`];
  if (api.servers.length > 0) lines.push(`Servers: ${api.servers.join(', ')}`);
  if (api.auth.length > 0) lines.push(`Auth: ${api.auth.map((scheme) => `${scheme.name} (${scheme.type}${scheme.scheme ? ` ${scheme.scheme}` : ''})`).join(', ')}`);
  for (const endpoint of api.endpoints) {
    lines.push(`- ${endpoint.method} ${endpoint.path}${endpoint.summary ? `: ${endpoint.summary}` : ''}${endpoint.parameters.length > 0 ? ` [${endpoint.parameters.join(', ')}]` : ''}${endpoint.requestBody ? ` body ${endpoint.requestBody}` : ''} -> ${endpoint.responses.join('; ') || 'no responses listed'}`);
  }
  return lines.join('\n');
}

/** The same for a schema file. */
export function describeDdl(structure: { tables: { name: string; schema?: string; columns: { name: string; type: string; nullable: boolean; primaryKey: boolean; references?: { table: string } }[]; foreignKeys: { columns: string[]; table: string }[] }[] }): string {
  const lines: string[] = [];
  for (const table of structure.tables) {
    lines.push(`## Table ${table.schema ? `${table.schema}.` : ''}${table.name}`);
    for (const column of table.columns) lines.push(`- ${column.name}: ${column.type}${column.primaryKey ? ' (primary key)' : ''}${column.nullable ? '' : ' not null'}${column.references ? ` -> ${column.references.table}` : ''}`);
    for (const fk of table.foreignKeys) lines.push(`- foreign key ${fk.columns.join(', ')} -> ${fk.table}`);
  }
  return lines.join('\n');
}
