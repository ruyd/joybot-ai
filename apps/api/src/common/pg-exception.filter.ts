import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { DatabaseError } from 'pg';

/** Maps Postgres errors to HTTP responses without leaking SQL details. */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('AppExceptionFilter');

  catch(err: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (err instanceof HttpException) {
      res.status(err.getStatus()).json(err.getResponse());
      return;
    }

    if (err instanceof DatabaseError) {
      const map: Record<string, [number, string]> = {
        '42501': [403, 'Not allowed'], // insufficient_privilege, incl. RLS WITH CHECK violations
        '23505': [409, 'Already exists'], // unique_violation
        '23514': [400, 'Invalid data'], // check_violation (incl. time zone validation)
        '23503': [400, 'Referenced record does not exist'], // foreign_key_violation
        '23502': [400, 'Missing required field'], // not_null_violation
        '22P02': [400, 'Invalid value'], // invalid_text_representation
        P0002: [404, 'Not found'], // no_data_found, raised by authz functions
      };
      const [status, generic] = map[err.code ?? ''] ?? [500, 'Internal error'];
      // Our own RAISE messages in authz functions (no constraint) are written for users; show them.
      const raised = !err.constraint && err.where?.includes('PL/pgSQL');
      const message = raised && status < 500 ? err.message : generic;
      if (status === 500) this.logger.error(err.message, err.stack);
      res.status(status).json({ statusCode: status, message, constraint: err.constraint });
      return;
    }

    this.logger.error(err instanceof Error ? err.stack : String(err));
    res.status(500).json({ statusCode: 500, message: 'Internal error' });
  }
}
