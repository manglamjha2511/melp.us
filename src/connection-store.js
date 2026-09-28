import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.js';

function publicConnection(connection) {
  const { encryptedAccessToken, ...safeConnection } = connection;
  return safeConnection;
}

export class ConnectionStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await this.writeAll([]);
    }
  }

  async readAll() {
    try {
      const file = await fs.readFile(this.filePath, 'utf8');
      const connections = JSON.parse(file);
      if (!Array.isArray(connections)) throw new Error('Expected an array.');
      return connections;
    } catch (error) {
      if (error instanceof SyntaxError || error.message === 'Expected an array.') {
        throw new AppError(500, 'CONNECTION_STORE_ERROR', 'Connection storage is invalid.');
      }
      throw error;
    }
  }

  async writeAll(connections) {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(connections, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(temporaryPath, this.filePath);
  }

  enqueueWrite(work) {
    this.writeQueue = this.writeQueue.then(work, work);
    return this.writeQueue;
  }

  async create(connection) {
    return this.enqueueWrite(async () => {
      const connections = await this.readAll();
      connections.push(connection);
      await this.writeAll(connections);
      return publicConnection(connection);
    });
  }

  async get(connectionId) {
    const connections = await this.readAll();
    return connections.find((connection) => connection.id === connectionId) || null;
  }

  async getRequired(connectionId) {
    const connection = await this.get(connectionId);
    if (!connection) {
      throw new AppError(404, 'CONNECTION_NOT_FOUND', 'No connection exists for this connectionId.');
    }
    return connection;
  }

  async listPublic() {
    return (await this.readAll()).map(publicConnection);
  }

  async remove(connectionId) {
    return this.enqueueWrite(async () => {
      const connections = await this.readAll();
      const remaining = connections.filter((connection) => connection.id !== connectionId);
      if (remaining.length === connections.length) {
        throw new AppError(404, 'CONNECTION_NOT_FOUND', 'No connection exists for this connectionId.');
      }
      await this.writeAll(remaining);
    });
  }
}
