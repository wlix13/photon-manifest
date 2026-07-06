/** Base HTTP error; the top-level error handler turns these into responses. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

/** 401 carrying the Basic challenge pip/twine/uv expect. */
export class Unauthorized extends HttpError {
  constructor(message = "Authentication required.") {
    super(401, message, { "WWW-Authenticate": 'Basic realm="photon-manifest"' });
  }
}

/** 403 for authenticated but insufficiently privileged requests. */
export class Forbidden extends HttpError {
  constructor(message = "Insufficient permissions.") {
    super(403, message);
  }
}

/** 404 for a missing named resource. */
export class NotFound extends HttpError {
  constructor(what: string) {
    super(404, `${what} not found.`);
  }
}

/** 400 for malformed or inconsistent input. */
export class BadRequest extends HttpError {
  constructor(message: string) {
    super(400, message);
  }
}

/** 409 for uniqueness violations (duplicate file, existing user, ...). */
export class Conflict extends HttpError {
  constructor(message: string) {
    super(409, message);
  }
}
