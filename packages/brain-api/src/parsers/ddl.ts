// A small reader of CREATE TABLE statements (FR-3.2): tables, columns with types, primary and foreign keys, for
// the common grammar of Postgres, MySQL and SQL Server DDL. What it does not understand it leaves out; the
// uploaded file stays the source of truth and is searchable as text.

export interface DdlColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  references?: { table: string; column?: string };
}

export interface DdlTable {
  name: string;
  schema?: string;
  columns: DdlColumn[];
  primaryKey: string[];
  foreignKeys: { columns: string[]; table: string; refColumns: string[] }[];
}

export interface DdlStructure {
  kind: 'ddl';
  tables: DdlTable[];
  statements: number;
}

const unquote = (name: string): string => name.replace(/^[`"[]|[`"\]]$/g, '').trim();

/** Split on commas at depth 0 (parentheses in types such as numeric(12,2) stay together). */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

const columnList = (text: string): string[] => text.split(',').map((item) => unquote(item.trim())).filter(Boolean);

export function parseDdl(sql: string): DdlStructure {
  const cleaned = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const tables: DdlTable[] = [];
  const pattern = /create\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?([^\s(]+)\s*\(/gi;
  let match: RegExpExecArray | null;
  let statements = 0;
  while ((match = pattern.exec(cleaned)) !== null) {
    statements++;
    // Find the matching closing parenthesis of the column list.
    let depth = 1;
    let i = pattern.lastIndex;
    for (; i < cleaned.length && depth > 0; i++) {
      if (cleaned[i] === '(') depth++;
      else if (cleaned[i] === ')') depth--;
    }
    const body = cleaned.slice(pattern.lastIndex, i - 1);
    pattern.lastIndex = i;
    const qualified = match[1]!.split('.').map(unquote);
    const table: DdlTable = { name: qualified.at(-1)!, ...(qualified.length > 1 ? { schema: qualified.slice(0, -1).join('.') } : {}), columns: [], primaryKey: [], foreignKeys: [] };
    for (const part of splitTopLevel(body)) {
      const lower = part.toLowerCase();
      const pk = /^(?:constraint\s+\S+\s+)?primary\s+key\s*\(([^)]*)\)/i.exec(part);
      if (pk) {
        table.primaryKey.push(...columnList(pk[1]!));
        continue;
      }
      const fk = /^(?:constraint\s+\S+\s+)?foreign\s+key\s*\(([^)]*)\)\s*references\s+([^\s(]+)\s*(?:\(([^)]*)\))?/i.exec(part);
      if (fk) {
        table.foreignKeys.push({ columns: columnList(fk[1]!), table: unquote(fk[2]!.split('.').at(-1)!), refColumns: fk[3] ? columnList(fk[3]) : [] });
        continue;
      }
      if (/^(?:constraint|unique|check|index|key|exclude|period)\b/i.test(lower)) continue;
      const column = /^(\S+)\s+([a-z_][\w ]*?(?:\([^)]*\))?(?:\s*\[\])?)(?=\s|$)([\s\S]*)$/i.exec(part);
      if (!column) continue;
      const rest = column[3] ?? '';
      const references = /references\s+([^\s(]+)\s*(?:\(([^)]*)\))?/i.exec(rest);
      const col: DdlColumn = {
        name: unquote(column[1]!),
        type: column[2]!.trim().replace(/\s+/g, ' '),
        nullable: !/not\s+null/i.test(rest) && !/primary\s+key/i.test(rest),
        primaryKey: /primary\s+key/i.test(rest),
        ...(references ? { references: { table: unquote(references[1]!.split('.').at(-1)!), ...(references[2] ? { column: unquote(references[2]) } : {}) } } : {}),
      };
      if (col.primaryKey) table.primaryKey.push(col.name);
      table.columns.push(col);
    }
    tables.push(table);
  }
  return { kind: 'ddl', tables, statements };
}
