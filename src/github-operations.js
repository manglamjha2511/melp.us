import { AppError, requireString } from './errors.js';
import { GitHubClient } from './github-client.js';

function numberInRange(value, fallback, min, max) {
  if (value === undefined || value === '') {
    if (fallback === undefined) {
      throw new AppError(400, 'VALIDATION_ERROR', 'A numeric value is required.');
    }
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new AppError(400, 'VALIDATION_ERROR', `Value must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function githubIdentifier(value, field) {
  const identifier = requireString(value, field, { maxLength: 100 });
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(identifier)) {
    throw new AppError(400, 'VALIDATION_ERROR', `${field} contains invalid characters.`);
  }
  return identifier;
}

function repositorySummary(repository) {
  return {
    id: repository.id,
    name: repository.name,
    fullName: repository.full_name,
    description: repository.description,
    private: repository.private,
    htmlUrl: repository.html_url,
    updatedAt: repository.updated_at,
  };
}

function issueSummary(issue) {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    htmlUrl: issue.html_url,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    author: issue.user?.login,
    labels: (issue.labels || []).map((label) => typeof label === 'string' ? label : label.name),
  };
}

export class GitHubOperations {
  constructor({ connectionStore, apiBaseUrl }) {
    this.connectionStore = connectionStore;
    this.apiBaseUrl = apiBaseUrl;
  }

  async client(connectionId) {
    const connection = await this.connectionStore.getRequired(requireString(connectionId, 'connectionId', { maxLength: 100 }));
    if (connection.provider !== 'github') {
      throw new AppError(400, 'UNSUPPORTED_PROVIDER', 'This connection is not a GitHub connection.');
    }
    return { connection, client: GitHubClient.fromConnection(connection, this.apiBaseUrl) };
  }

  async listOrSearchRepositories({ connectionId, query, page, perPage }) {
    const { connection, client } = await this.client(connectionId);
    const selectedPage = numberInRange(page, 1, 1, 10_000);
    const selectedPerPage = numberInRange(perPage, 20, 1, 100);
    const params = new URLSearchParams({ page: String(selectedPage), per_page: String(selectedPerPage) });

    if (query?.trim()) {
      const selectedQuery = requireString(query, 'query', { maxLength: 256 });
      params.set('q', `${selectedQuery} user:${connection.accountLogin}`);
      const response = await client.request(`/search/repositories?${params}`);
      return {
        mode: 'search',
        page: selectedPage,
        perPage: selectedPerPage,
        totalCount: response.total_count,
        repositories: response.items.map(repositorySummary),
      };
    }

    params.set('sort', 'updated');
    params.set('direction', 'desc');
    const repositories = await client.request(`/user/repos?${params}`);
    return {
      mode: 'list',
      page: selectedPage,
      perPage: selectedPerPage,
      repositories: repositories.map(repositorySummary),
    };
  }

  async createIssue({ connectionId, owner, repository, title, body }) {
    const { client } = await this.client(connectionId);
    const selectedOwner = githubIdentifier(owner, 'owner');
    const selectedRepository = githubIdentifier(repository, 'repository');
    const selectedTitle = requireString(title, 'title', { maxLength: 256 });
    const selectedBody = body === undefined ? undefined : requireString(body, 'body', { minLength: 0, maxLength: 65_536 });
    const issue = await client.request(`/repos/${encodeURIComponent(selectedOwner)}/${encodeURIComponent(selectedRepository)}/issues`, {
      method: 'POST',
      body: { title: selectedTitle, ...(selectedBody !== undefined ? { body: selectedBody } : {}) },
    });
    return issueSummary(issue);
  }

  async getIssue({ connectionId, owner, repository, issueNumber }) {
    const { client } = await this.client(connectionId);
    const selectedOwner = githubIdentifier(owner, 'owner');
    const selectedRepository = githubIdentifier(repository, 'repository');
    const selectedIssueNumber = numberInRange(issueNumber, undefined, 1, 9_999_999);
    const issue = await client.request(`/repos/${encodeURIComponent(selectedOwner)}/${encodeURIComponent(selectedRepository)}/issues/${selectedIssueNumber}`);
    return issueSummary(issue);
  }
}
