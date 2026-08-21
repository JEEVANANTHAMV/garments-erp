export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string = 'ERROR',
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const BadRequest   = (m: string, d?: unknown) => new AppError(400, m, 'BAD_REQUEST', d);
export const Unauthorized = (m = 'Authentication required') => new AppError(401, m, 'UNAUTHORIZED');
export const Forbidden    = (m = 'You do not have permission to perform this action') => new AppError(403, m, 'FORBIDDEN');
export const NotFound     = (m = 'Resource not found') => new AppError(404, m, 'NOT_FOUND');
export const Conflict     = (m: string, d?: unknown) => new AppError(409, m, 'CONFLICT', d);
export const Unprocessable= (m: string, d?: unknown) => new AppError(422, m, 'UNPROCESSABLE', d);
