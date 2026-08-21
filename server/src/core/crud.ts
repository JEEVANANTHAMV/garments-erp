import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, queryOne, execute, transaction, txQueryOne, txExecute } from '../config/db.js';
import { ah } from './asyncHandler.js';
import { BadRequest, NotFound } from './errors.js';
import { requirePermission } from '../middleware/auth.js';
import { audit } from './audit.js';
import { nextDocNumber } from './numbering.js';

export interface FieldDef {
  /** Column name in the table. */
  name: string;
  /** Zod schema used on create/update. Omit for read-only columns. */
  schema?: z.ZodTypeAny;
  /** Column is settable on create but not on update. */
  immutable?: boolean;
}

export interface ResourceConfig {
  /** URL segment, e.g. 'parties'. */
  path: string;
  /** Physical table name. */
  table: string;
  /** Permission code prefix, e.g. 'PARTY' -> PARTY.VIEW / .CREATE / .UPDATE / .DELETE */
  permission: string;
  /** Human label for error messages. */
  label: string;
  /** Writable fields. */
  fields: FieldDef[];
  /** Columns matched by the `q` search param (LIKE). */
  searchable?: string[];
  /** Columns allowed in ?sort=. Defaults to id. */
  sortable?: string[];
  /** Default ORDER BY clause. */
  defaultSort?: string;
  /** Table carries company_id and must be tenant-scoped. Default true. */
  companyScoped?: boolean;
  /** Table has is_deleted. Default auto-detected at boot. */
  softDelete?: boolean;
  /** Table has is_active. */
  hasIsActive?: boolean;
  /** Table has created_by/updated_by audit columns. */
  hasAuditCols?: boolean;
  /** Extra SELECT expressions (joins for display labels). */
  selectExtra?: string;
  /** JOIN clauses used with selectExtra. */
  joins?: string;
  /** Equality filters accepted as query params. */
  filters?: string[];
  /** Auto-generate this column from a number series if not supplied. */
  autoNumber?: { column: string; docType: string };
  /** Child collections written together with the parent. */
  children?: ChildConfig[];
}

export interface ChildConfig {
  /** Key in the request body holding the array of child rows. */
  key: string;
  table: string;
  /** FK column on the child pointing at the parent id. */
  fk: string;
  fields: FieldDef[];
  /** ORDER BY when reading children back. */
  orderBy?: string;
}

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().max(200).optional(),
  sort: z.string().max(80).optional(),
  dir: z.enum(['asc', 'desc']).default('desc'),
  includeInactive: z.coerce.boolean().default(false),
});

/** Reject anything that is not a plain identifier — guards ORDER BY injection. */
const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function pickWritable(fields: FieldDef[], body: any, isUpdate: boolean) {
  const data: Record<string, unknown> = {};
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of fields) {
    if (!f.schema) continue;
    if (isUpdate && f.immutable) continue;
    shape[f.name] = isUpdate ? f.schema.optional() : f.schema;
  }
  const parsed = z.object(shape).strip().parse(body ?? {});
  for (const [k, v] of Object.entries(parsed)) {
    if (v !== undefined) data[k] = v;
  }
  return data;
}

export function buildResourceRouter(cfg: ResourceConfig): Router {
  const r = Router();
  const {
    table, permission, label, fields,
    companyScoped = true,
    softDelete = true,
    hasIsActive = true,
    hasAuditCols = true,
    searchable = [], sortable = [], filters = [],
    selectExtra = '', joins = '',
    defaultSort = 't.id',
    children = [],
    autoNumber,
  } = cfg;

  const scope = (req: Request) => (companyScoped ? req.user!.companyId : null);

  /** Shared WHERE builder for list/count. */
  function buildWhere(req: Request, opts: z.infer<typeof listQuerySchema>) {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];

    if (companyScoped) { where.push('t.company_id = ?'); params.push(scope(req)); }
    if (softDelete) where.push('t.is_deleted = 0');
    if (hasIsActive && !opts.includeInactive) where.push('t.is_active = 1');

    if (opts.q && searchable.length) {
      where.push(`(${searchable.map((c) => `t.${c} LIKE ?`).join(' OR ')})`);
      for (const _ of searchable) params.push(`%${opts.q}%`);
    }

    for (const f of filters) {
      const raw = req.query[f];
      if (raw === undefined || raw === '') continue;
      if (!IDENT.test(f)) continue;
      if (raw === 'null') { where.push(`t.${f} IS NULL`); continue; }
      where.push(`t.${f} = ?`);
      params.push(raw);
    }

    // Generic date-range support: ?dateFrom / ?dateTo against ?dateField
    const dateField = String(req.query.dateField ?? '');
    if (dateField && IDENT.test(dateField)) {
      if (req.query.dateFrom) { where.push(`t.${dateField} >= ?`); params.push(req.query.dateFrom); }
      if (req.query.dateTo)   { where.push(`t.${dateField} <= ?`); params.push(req.query.dateTo); }
    }

    return { clause: where.join(' AND '), params };
  }

  // ---------------------------------------------------------------- LIST
  r.get('/', requirePermission(`${permission}.VIEW`), ah(async (req, res) => {
    const opts = listQuerySchema.parse(req.query);
    const { clause, params } = buildWhere(req, opts);

    let orderBy = defaultSort;
    if (opts.sort && IDENT.test(opts.sort) && (sortable.includes(opts.sort) || opts.sort === 'id')) {
      orderBy = `t.${opts.sort}`;
    }
    const dir = opts.dir === 'asc' ? 'ASC' : 'DESC';
    const offset = (opts.page - 1) * opts.pageSize;

    const [rows, countRow] = await Promise.all([
      query(
        `SELECT t.* ${selectExtra ? ', ' + selectExtra : ''}
           FROM ${table} t ${joins}
          WHERE ${clause}
          ORDER BY ${orderBy} ${dir}
          LIMIT ${opts.pageSize} OFFSET ${offset}`,
        params,
      ),
      queryOne<{ total: number }>(
        `SELECT COUNT(*) AS total FROM ${table} t ${joins} WHERE ${clause}`, params,
      ),
    ]);

    res.json({
      data: rows,
      pagination: {
        page: opts.page,
        pageSize: opts.pageSize,
        total: countRow?.total ?? 0,
        totalPages: Math.ceil((countRow?.total ?? 0) / opts.pageSize),
      },
    });
  }));

  // ------------------------------------------------------------- GET ONE
  r.get('/:id', requirePermission(`${permission}.VIEW`), ah(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw BadRequest('Invalid id');

    const where = [`t.id = ?`];
    const params: unknown[] = [id];
    if (companyScoped) { where.push('t.company_id = ?'); params.push(scope(req)); }

    const row = await queryOne(
      `SELECT t.* ${selectExtra ? ', ' + selectExtra : ''}
         FROM ${table} t ${joins} WHERE ${where.join(' AND ')} LIMIT 1`,
      params,
    );
    if (!row) throw NotFound(`${label} not found`);

    for (const c of children) {
      (row as any)[c.key] = await query(
        `SELECT * FROM ${c.table} WHERE ${c.fk} = ? ORDER BY ${c.orderBy ?? 'id'}`, [id],
      );
    }
    res.json({ data: row });
  }));

  // -------------------------------------------------------------- CREATE
  r.post('/', requirePermission(`${permission}.CREATE`), ah(async (req, res) => {
    const data = pickWritable(fields, req.body, false);

    const created = await transaction(async (tx) => {
      if (companyScoped) data.company_id = scope(req);
      if (hasAuditCols) data.created_by = req.user!.id;

      if (autoNumber && !data[autoNumber.column]) {
        data[autoNumber.column] = await nextDocNumber(
          tx, req.user!.companyId, autoNumber.docType,
          { branchId: (data.branch_id as number) ?? null },
        );
      }

      const cols = Object.keys(data);
      if (!cols.length) throw BadRequest('No data supplied');
      const result = await txExecute(
        tx,
        `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
        cols.map((c) => data[c]),
      );
      const newId = result.insertId;

      for (const c of children) {
        const rows = req.body?.[c.key];
        if (!Array.isArray(rows)) continue;
        for (const raw of rows) {
          const childData = pickWritable(c.fields, raw, false);
          childData[c.fk] = newId;
          const ccols = Object.keys(childData);
          await txExecute(
            tx,
            `INSERT INTO ${c.table} (${ccols.join(',')}) VALUES (${ccols.map(() => '?').join(',')})`,
            ccols.map((k) => childData[k]),
          );
        }
      }

      return txQueryOne(tx, `SELECT * FROM ${table} WHERE id = ?`, [newId]);
    });

    await audit(req, table, (created as any).id, 'INSERT', undefined, created);
    res.status(201).json({ data: created });
  }));

  // -------------------------------------------------------------- UPDATE
  r.put('/:id', requirePermission(`${permission}.UPDATE`), ah(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw BadRequest('Invalid id');

    const scopeSql = companyScoped ? ' AND company_id = ?' : '';
    const scopeParams = companyScoped ? [scope(req)] : [];

    const before = await queryOne(`SELECT * FROM ${table} WHERE id = ?${scopeSql}`, [id, ...scopeParams]);
    if (!before) throw NotFound(`${label} not found`);

    const data = pickWritable(fields, req.body, true);
    if (hasAuditCols) data.updated_by = req.user!.id;

    const after = await transaction(async (tx) => {
      const cols = Object.keys(data);
      if (cols.length) {
        await txExecute(
          tx,
          `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?${scopeSql}`,
          [...cols.map((c) => data[c]), id, ...scopeParams],
        );
      }

      // Children are replace-on-write: simplest correct semantics for
      // header/detail documents edited as a single form.
      for (const c of children) {
        const rows = req.body?.[c.key];
        if (!Array.isArray(rows)) continue;
        await txExecute(tx, `DELETE FROM ${c.table} WHERE ${c.fk} = ?`, [id]);
        for (const raw of rows) {
          const childData = pickWritable(c.fields, raw, false);
          childData[c.fk] = id;
          const ccols = Object.keys(childData);
          await txExecute(
            tx,
            `INSERT INTO ${c.table} (${ccols.join(',')}) VALUES (${ccols.map(() => '?').join(',')})`,
            ccols.map((k) => childData[k]),
          );
        }
      }
      return txQueryOne(tx, `SELECT * FROM ${table} WHERE id = ?`, [id]);
    });

    await audit(req, table, id, 'UPDATE', before, after);
    res.json({ data: after });
  }));

  // -------------------------------------------------------------- DELETE
  r.delete('/:id', requirePermission(`${permission}.DELETE`), ah(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw BadRequest('Invalid id');

    const scopeSql = companyScoped ? ' AND company_id = ?' : '';
    const scopeParams = companyScoped ? [scope(req)] : [];

    const before = await queryOne(`SELECT * FROM ${table} WHERE id = ?${scopeSql}`, [id, ...scopeParams]);
    if (!before) throw NotFound(`${label} not found`);

    if (softDelete) {
      await execute(
        `UPDATE ${table} SET is_deleted = 1${hasAuditCols ? ', updated_by = ?' : ''} WHERE id = ?${scopeSql}`,
        hasAuditCols ? [req.user!.id, id, ...scopeParams] : [id, ...scopeParams],
      );
    } else {
      await execute(`DELETE FROM ${table} WHERE id = ?${scopeSql}`, [id, ...scopeParams]);
    }

    await audit(req, table, id, 'DELETE', before, undefined);
    res.json({ data: { id, deleted: true } });
  }));

  return r;
}
