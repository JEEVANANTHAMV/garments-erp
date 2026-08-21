import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../core/errors.js';
import { env } from '../config/env.js';

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.originalUrl}` } });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  // Zod validation -> 422 with field-level detail
  if (err instanceof ZodError) {
    return res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The submitted data is invalid',
        details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      },
    });
  }

  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  // Translate common MySQL errors into meaningful HTTP responses
  const e = err as { code?: string; sqlMessage?: string; message?: string };
  if (e?.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({
      error: { code: 'DUPLICATE', message: 'A record with these unique values already exists', details: e.sqlMessage },
    });
  }
  if (e?.code === 'ER_NO_REFERENCED_ROW_2' || e?.code === 'ER_NO_REFERENCED_ROW') {
    return res.status(422).json({
      error: { code: 'FK_INVALID', message: 'A referenced record does not exist', details: e.sqlMessage },
    });
  }
  if (e?.code === 'ER_ROW_IS_REFERENCED_2' || e?.code === 'ER_ROW_IS_REFERENCED') {
    return res.status(409).json({
      error: { code: 'FK_IN_USE', message: 'This record is referenced by other records and cannot be deleted', details: e.sqlMessage },
    });
  }
  if (e?.code === 'ER_BAD_NULL_ERROR') {
    return res.status(422).json({
      error: { code: 'NULL_NOT_ALLOWED', message: 'A required field was left empty', details: e.sqlMessage },
    });
  }

  console.error('[unhandled]', err);
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      ...(env.isProd ? {} : { details: e?.message, stack: (err as Error)?.stack }),
    },
  });
}
