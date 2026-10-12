import { describe, expect, it } from 'vitest';
import { parseDdl } from './ddl.ts';
import { describeApi, parseOpenApi } from './openapi.ts';

describe('parseDdl', () => {
  it('reads tables, columns, keys and references across dialects', () => {
    const sql = `
      -- orders
      CREATE TABLE erp.customers (
        id serial PRIMARY KEY,
        name varchar(200) NOT NULL,
        vat_no char(11)
      );
      CREATE TABLE IF NOT EXISTS erp."orders" (
        id bigint NOT NULL,
        customer_id integer REFERENCES erp.customers(id),
        total numeric(12,2) DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT orders_pk PRIMARY KEY (id),
        CONSTRAINT orders_customer FOREIGN KEY (customer_id) REFERENCES erp.customers (id),
        UNIQUE (id, created_at)
      );
      CREATE TABLE [dbo].[Items] ([ItemId] INT NOT NULL PRIMARY KEY, [Label] NVARCHAR(50));
    `;
    const result = parseDdl(sql);
    expect(result.statements).toBe(3);
    expect(result.tables.map((table) => table.name)).toEqual(['customers', 'orders', 'Items']);
    const customers = result.tables[0]!;
    expect(customers.schema).toBe('erp');
    expect(customers.columns.map((column) => [column.name, column.type, column.nullable, column.primaryKey])).toEqual([
      ['id', 'serial', false, true],
      ['name', 'varchar(200)', false, false],
      ['vat_no', 'char(11)', true, false],
    ]);
    const orders = result.tables[1]!;
    expect(orders.primaryKey).toEqual(['id']);
    expect(orders.columns.find((column) => column.name === 'customer_id')?.references).toEqual({ table: 'customers', column: 'id' });
    expect(orders.columns.find((column) => column.name === 'total')?.type).toBe('numeric(12,2)');
    expect(orders.foreignKeys).toEqual([{ columns: ['customer_id'], table: 'customers', refColumns: ['id'] }]);
    expect(result.tables[2]!.columns.map((column) => column.name)).toEqual(['ItemId', 'Label']);
  });
});

describe('parseOpenApi', () => {
  it('reads an OpenAPI 3 document in YAML', () => {
    const yaml = `
openapi: 3.0.3
info:
  title: Warehouse API
servers:
  - url: https://api.example.com/v1
components:
  securitySchemes:
    bearer:
      type: http
      scheme: bearer
security:
  - bearer: []
paths:
  /items/{id}:
    parameters:
      - name: id
        in: path
        required: true
    get:
      summary: One item
      operationId: getItem
      tags: [items]
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Item'
    put:
      summary: Replace an item
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Item'
      responses:
        '204':
          description: Replaced
`;
    const api = parseOpenApi(yaml);
    expect(api?.title).toBe('Warehouse API');
    expect(api?.servers).toEqual(['https://api.example.com/v1']);
    expect(api?.auth).toEqual([{ name: 'bearer', type: 'http', scheme: 'bearer' }]);
    expect(api?.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`)).toEqual(['GET /items/{id}', 'PUT /items/{id}']);
    expect(api?.endpoints[0]).toMatchObject({ parameters: ['id (path)'], responses: ['200: Item'], auth: ['bearer'], tags: ['items'] });
    expect(api?.endpoints[1]).toMatchObject({ requestBody: 'Item', responses: ['204: Replaced'] });
    expect(describeApi(api!)).toContain('- GET /items/{id}: One item [id (path)] -> 200: Item');
  });

  it('reads Swagger 2 in JSON and refuses other files', () => {
    const api = parseOpenApi(JSON.stringify({ swagger: '2.0', info: { title: 'Legacy' }, host: 'legacy.example.com', basePath: '/api', paths: { '/ping': { get: { responses: { '200': { description: 'pong' } } } } } }));
    expect(api?.servers).toEqual(['https://legacy.example.com/api']);
    expect(api?.endpoints[0]).toMatchObject({ method: 'GET', path: '/ping', responses: ['200: pong'] });
    expect(parseOpenApi('name: not an api')).toBeUndefined();
    expect(parseOpenApi('{ not json')).toBeUndefined();
  });
});
