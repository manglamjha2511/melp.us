export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function requireString(value, field, { minLength = 1, maxLength = 5000 } = {}) {
  if (typeof value !== 'string' || value.trim().length < minLength) {
    throw new AppError(400, 'VALIDATION_ERROR', `${field} is required.`);
  }
  if (value.length > maxLength) {
    throw new AppError(400, 'VALIDATION_ERROR', `${field} is too long.`);
  }
  return value.trim();
}
