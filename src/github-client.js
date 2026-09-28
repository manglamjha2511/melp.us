import { decrypt } from './config.js';
import { AppError } from './errors.js';

function toProviderError(response, payload) {
  const message = payload?.message || `GitHub returned HTTP ${response.status}.`;
  const details = payload?.errors ? { providerErrors: payload.errors } : undefined;

  if (response.status === 401) {
    return new AppError(401, 'AUTHENTICATION_FAILED', 'GitHub rejected the saved access token. Reconnect the account.', details);
  }
  if (response.status === 404) {
    return new AppError(404, 'RESOURCE_NOT_FOUND', message, details);
  }
  if (response.status === 422) {
    return new AppError(422, 'PROVIDER_VALIDATION_ERROR', message, details);
  }
  if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
    return new AppError(429, 'RATE_LIMITED', message, {
      retryAfter: response.headers.get('retry-after'),
      rateLimitReset: response.headers.get('x-ratelimit-reset'),
    });
  }
  return new AppError(502, 'PROVIDER_API_ERROR', message, {
    providerStatus: response.status,
    ...details,
  });
}

async function jsonOrNull(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}

export class GitHubClient {
  constructor({ accessToken, apiBaseUrl }) {
    this.accessToken = accessToken;
    this.apiBaseUrl = apiBaseUrl;
  }

  static fromConnection(connection, apiBaseUrl) {
    let accessToken;
    try {
      accessToken = decrypt(connection.encryptedAccessToken);
    } catch {
      throw new AppError(500, 'CONNECTION_CREDENTIAL_ERROR', 'The saved connection credential cannot be decrypted.');
    }
    return new GitHubClient({ accessToken, apiBaseUrl });
  }

  async request(path, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await fetch(`${this.apiBaseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.accessToken}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'mini-nango-github-poc',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new AppError(502, 'PROVIDER_UNAVAILABLE', 'Could not reach the GitHub API. Please try again.', {
        cause: error.name,
      });
    }

    const payload = await jsonOrNull(response);
    if (!response.ok) throw toProviderError(response, payload);
    return payload;
  }
}
