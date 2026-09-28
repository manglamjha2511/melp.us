# Mini-Nango GitHub POC

A compact integration service inspired by Nango. It connects a GitHub account via OAuth 2.0 Device Flow, stores the connection locally, and exposes repository and issue operations through a reusable API layer.

GitHub was selected from the Nango catalog because it offers a real OAuth flow plus practical read/search and write APIs. This is intentionally a local proof of concept, not a multi-tenant integration platform.

## Assignment coverage

- **Connect/authenticate:** GitHub OAuth Device Flow; no personal access token is entered into the app.
- **Connection management:** connected account metadata is stored and listed; a connection can be removed.
- **Secure credential handling:** access tokens are encrypted with AES-256-GCM before local persistence and are never returned by the API.
- **Reusable API layer:** `GitHubClient` owns bearer authentication, API headers, timeouts, and provider-error translation.
- **Provider operations:**
  1. List or search repositories — read/search.
  2. Create an issue — create.
  3. Get issue details — additional useful operation.
- **Working demo:** browser UI and documented JSON API/curl walkthrough.

## Architecture

```text
Browser or application
        │
        ▼
Mini-Nango integration service (Node.js)
  ├── Device Flow connection manager
  ├── Encrypted local connection store
  ├── Shared authenticated GitHub API client
  └── Repository / issue operations
        │
        ▼
GitHub OAuth + REST API
```

The included browser page is a demonstration client. The same API can be called by another application, curl, or an API client.

## Prerequisites

- Node.js 20.6 or later (tested with Node 22).
- A GitHub account and GitHub **OAuth App** with Device Flow enabled.

### Create the GitHub OAuth App

1. Open GitHub **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Use `http://localhost:3000` for the homepage. A callback URL is required by the registration form but is not used by Device Flow; `http://localhost:3000` is suitable.
3. Select **Enable Device Flow** and register the application.
4. Copy the app's **Client ID**. Do not put a client secret in this project; this Device Flow needs only the client ID.

GitHub requires Device Flow to be enabled for the OAuth app. Its sequence is request a user code, let the user approve it in a browser, then poll for an access token. See [GitHub’s Device Flow documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).

If **Start secure connection** reports `OAUTH_CONFIGURATION_ERROR` or GitHub returns `Not Found`, the configured ID does not identify an eligible OAuth App. In GitHub, open **Settings → Developer settings → OAuth Apps**, select or create the app, enable **Device Flow**, copy its **Client ID** (not its Client Secret or a GitHub App ID) into `.env`, and restart the service.

## Setup and run

There are no third-party runtime dependencies to install.

1. Copy the environment template:

   ```powershell
   Copy-Item .env.example .env
   ```

2. Edit `.env`:

   ```dotenv
   GITHUB_CLIENT_ID=Ov23li_your_real_client_id
   CONNECTION_ENCRYPTION_KEY=your_32_byte_base64_key
   PORT=3000
   ```

   Generate the encryption key with:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

3. Start the service:

   ```powershell
   npm start
   ```

4. Visit [http://localhost:3000](http://localhost:3000), choose **Start secure connection**, open the GitHub link, enter the displayed one-time code, and approve the scopes.
5. Select the saved account, list/search repositories, create an issue in a repository where the account has permission, and retrieve that issue by number.

The requested scopes are `repo read:user`. The `repo` scope is required for repository access and creating issues, so only connect an account you are comfortable authorizing for this local demo.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `GITHUB_CLIENT_ID` | Yes | Public client ID for the OAuth App with Device Flow enabled. |
| `CONNECTION_ENCRYPTION_KEY` | Yes | Base64-encoded 32-byte key used for AES-256-GCM token encryption. |
| `PORT` | No | HTTP port; defaults to `3000`. |
| `CONNECTION_STORE_PATH` | No | JSON connection-store path; defaults to `./data/connections.json`. |

`.env` and `data/` are ignored by Git. Never commit either. Changing the encryption key makes existing stored credentials unreadable, so disconnect/reconnect those accounts after key rotation.

## API walkthrough

All responses are JSON. Begin authentication:

```bash
curl -X POST http://localhost:3000/api/connections/github/device/start
```

Example response (all values are short-lived examples):

```json
{
  "authSessionId": "b4555bd9-570f-425a-8e97-5c9f4a586ad1",
  "userCode": "ABCD-EFGH",
  "verificationUri": "https://github.com/login/device",
  "expiresIn": 900,
  "pollAfterSeconds": 5
}
```

Open `verificationUri`, enter `userCode`, then poll at the returned interval:

```bash
curl -X POST http://localhost:3000/api/connections/github/device/poll \
  -H "Content-Type: application/json" \
  -d '{"authSessionId":"b4555bd9-570f-425a-8e97-5c9f4a586ad1"}'
```

Before approval, polling returns `{"status":"pending","pollAfterSeconds":5}`. Once approved it returns a safe connection object. No access token is included. Set its `connection.id` as `CONNECTION_ID` below.

### 1. List or search repositories

```bash
curl "http://localhost:3000/api/github/repositories?connectionId=CONNECTION_ID"
curl "http://localhost:3000/api/github/repositories?connectionId=CONNECTION_ID&query=api"
```

The first call lists recently updated repositories. With `query`, it uses GitHub repository search constrained to the connected account.

### 2. Create an issue

```bash
curl -X POST http://localhost:3000/api/github/issues \
  -H "Content-Type: application/json" \
  -d '{
    "connectionId":"CONNECTION_ID",
    "owner":"YOUR_GITHUB_LOGIN",
    "repository":"YOUR_TEST_REPOSITORY",
    "title":"Mini-Nango POC test issue",
    "body":"Created through the integration layer."
  }'
```

Example response:

```json
{
  "issue": {
    "number": 17,
    "title": "Mini-Nango POC test issue",
    "state": "open",
    "htmlUrl": "https://github.com/YOUR_GITHUB_LOGIN/YOUR_TEST_REPOSITORY/issues/17"
  }
}
```

### 3. Get issue details

```bash
curl "http://localhost:3000/api/github/issues/YOUR_GITHUB_LOGIN/YOUR_TEST_REPOSITORY/17?connectionId=CONNECTION_ID"
```

### Connection management

```bash
curl http://localhost:3000/api/connections
curl -X DELETE http://localhost:3000/api/connections/CONNECTION_ID
```

## Failure handling

Errors have a predictable shape:

```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Not Found"
  }
}
```

| Situation | HTTP status / code |
| --- | --- |
| Missing or malformed input | `400` / `VALIDATION_ERROR` or `INVALID_JSON` |
| Missing/expired device session | `404` / `AUTH_SESSION_NOT_FOUND` |
| Unknown saved connection | `404` / `CONNECTION_NOT_FOUND` |
| Rejected or expired token | `401` / `AUTHENTICATION_FAILED` |
| Missing GitHub resource | `404` / `RESOURCE_NOT_FOUND` |
| GitHub validation failure | `422` / `PROVIDER_VALIDATION_ERROR` |
| GitHub rate limit | `429` / `RATE_LIMITED` |
| Provider/network failure | `502` / `PROVIDER_API_ERROR` or `PROVIDER_UNAVAILABLE` |

GitHub OAuth Apps can issue expiring user tokens. To keep this POC focused and avoid storing an OAuth app client secret merely for refresh-token rotation, an expired/rejected token produces a clear reconnect error. Reconnect through Device Flow when that happens.

## Security and design decisions

- **Device Flow over callback OAuth:** best fit for a local POC; approval happens at GitHub and no public callback URL or client secret is needed.
- **Single API client:** token logic, GitHub API version headers, timeouts, and error mapping live in `src/github-client.js`, not inside each operation.
- **Encrypted connection record:** `src/config.js` uses AES-256-GCM with a random IV. `src/connection-store.js` writes atomically and strips credentials before every response. On Unix, new store files are created with owner-only permissions. Protect the encryption key and local filesystem in a real deployment.
- **Small output model:** only useful repository/issue fields are returned, keeping the API readable and avoiding accidental credential exposure.
- **Deliberate boundaries:** storage and in-progress device-code sessions are local-process state. Production would add a managed encrypted database/key manager, tenant authorization, token refresh rotation, auditing, and distributed session storage.

## Verification

```powershell
npm test
```

The tests cover connection persistence/token redaction and service health/connection behavior without a GitHub account. The browser or curl walkthrough is the real end-to-end provider demo after you set a real OAuth App client ID.

## Project layout

```text
src/
  config.js                environment validation + AES-GCM helpers
  connection-store.js      encrypted connection persistence
  github-device-flow.js    OAuth Device Flow lifecycle
  github-client.js         reusable authenticated provider client
  github-operations.js     repository and issue operations
  server.js                HTTP integration API + demo static files
public/                    small browser demonstration client
test/                      Node built-in test suite
```
