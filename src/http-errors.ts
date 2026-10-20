/** Error con código HTTP y mensaje pensado para mostrarse en la interfaz. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST') => new HttpError(400, code, message);
export const unauthorized = (message = 'Inicia sesión para continuar.') => new HttpError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'No tienes permiso para hacer esto.') => new HttpError(403, 'FORBIDDEN', message);
export const notFound = (what: string) => new HttpError(404, 'NOT_FOUND', `${what} no existe o se ha eliminado.`);
export const conflict = (message: string) => new HttpError(409, 'CONFLICT', message);
