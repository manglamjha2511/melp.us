const elements = {
  connectButton: document.querySelector('#connectButton'),
  devicePanel: document.querySelector('#devicePanel'),
  verificationLink: document.querySelector('#verificationLink'),
  userCode: document.querySelector('#userCode'),
  connectionStatus: document.querySelector('#connectionStatus'),
  connectionSelect: document.querySelector('#connectionSelect'),
  refreshConnectionsButton: document.querySelector('#refreshConnectionsButton'),
  disconnectButton: document.querySelector('#disconnectButton'),
  repositoryForm: document.querySelector('#repositoryForm'),
  repositoriesResult: document.querySelector('#repositoriesResult'),
  createIssueForm: document.querySelector('#createIssueForm'),
  getIssueForm: document.querySelector('#getIssueForm'),
  operationResult: document.querySelector('#operationResult'),
};

let pollingTimer;

function selectedConnectionId() {
  const id = elements.connectionSelect.value;
  if (!id) throw new Error('Connect and select a GitHub account first.');
  return id;
}

function showJson(element, value) {
  element.textContent = JSON.stringify(value, null, 2);
}

function showError(element, error) {
  element.textContent = `Error: ${error.message}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || `Request failed (${response.status}).`);
    error.code = payload.error?.code;
    throw error;
  }
  return payload;
}

async function refreshConnections(selectId) {
  const { connections } = await api('/api/connections');
  const current = selectId || elements.connectionSelect.value;
  elements.connectionSelect.replaceChildren(new Option('No connected account', ''));
  connections.forEach((connection) => {
    const option = new Option(`${connection.accountLogin} · connected ${new Date(connection.createdAt).toLocaleString()}`, connection.id);
    elements.connectionSelect.add(option);
  });
  elements.connectionSelect.value = connections.some((connection) => connection.id === current) ? current : (connections[0]?.id || '');
}

async function pollForConnection(authSessionId, delaySeconds) {
  clearTimeout(pollingTimer);
  pollingTimer = setTimeout(async () => {
    try {
      const result = await api('/api/connections/github/device/poll', {
        method: 'POST',
        body: JSON.stringify({ authSessionId }),
      });
      if (result.status === 'pending') {
        elements.connectionStatus.textContent = 'Waiting for authorization…';
        return pollForConnection(authSessionId, result.pollAfterSeconds);
      }
      elements.connectionStatus.textContent = `Connected as ${result.connection.accountLogin}.`;
      elements.connectButton.disabled = false;
      await refreshConnections(result.connection.id);
    } catch (error) {
      elements.connectionStatus.textContent = `Connection failed: ${error.message}`;
      elements.connectButton.disabled = false;
    }
  }, Math.max(1, delaySeconds) * 1000);
}

elements.connectButton.addEventListener('click', async () => {
  try {
    clearTimeout(pollingTimer);
    elements.connectButton.disabled = true;
    elements.userCode.textContent = 'Generating…';
    elements.connectionStatus.textContent = 'Requesting one-time code from GitHub…';
    elements.devicePanel.hidden = false;
    const result = await api('/api/connections/github/device/start', { method: 'POST' });
    elements.verificationLink.href = result.verificationUri;
    elements.verificationLink.textContent = result.verificationUri;
    elements.userCode.textContent = result.userCode;
    elements.connectionStatus.textContent = 'Waiting for authorization…';
    pollForConnection(result.authSessionId, result.pollAfterSeconds);
  } catch (error) {
    elements.connectButton.disabled = false;
    elements.devicePanel.hidden = false;
    elements.userCode.textContent = 'FAILED';
    elements.connectionStatus.textContent = `Could not generate code: ${error.message}`;
    showError(elements.operationResult, error);
  }
});

elements.refreshConnectionsButton.addEventListener('click', () => refreshConnections().catch((error) => showError(elements.operationResult, error)));

elements.disconnectButton.addEventListener('click', async () => {
  try {
    const connectionId = selectedConnectionId();
    await api(`/api/connections/${encodeURIComponent(connectionId)}`, { method: 'DELETE' });
    await refreshConnections();
    showJson(elements.operationResult, { disconnected: true });
  } catch (error) {
    showError(elements.operationResult, error);
  }
});

elements.repositoryForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const params = new URLSearchParams({ connectionId: selectedConnectionId() });
    const query = new FormData(event.currentTarget).get('query').trim();
    if (query) params.set('query', query);
    const result = await api(`/api/github/repositories?${params}`);
    showJson(elements.repositoriesResult, result);
  } catch (error) {
    showError(elements.repositoriesResult, error);
  }
});

elements.createIssueForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const result = await api('/api/github/issues', {
      method: 'POST',
      body: JSON.stringify({ connectionId: selectedConnectionId(), ...values }),
    });
    showJson(elements.operationResult, result);
  } catch (error) {
    showError(elements.operationResult, error);
  }
});

elements.getIssueForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const path = `/api/github/issues/${encodeURIComponent(values.owner)}/${encodeURIComponent(values.repository)}/${encodeURIComponent(values.issueNumber)}?${new URLSearchParams({ connectionId: selectedConnectionId() })}`;
    showJson(elements.operationResult, await api(path));
  } catch (error) {
    showError(elements.operationResult, error);
  }
});

refreshConnections().catch((error) => showError(elements.operationResult, error));
