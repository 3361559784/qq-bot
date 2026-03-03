const path = require('path');
const { spawn } = require('child_process');

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const x = Math.trunc(n);
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

function resolveCommand(options = {}) {
  const cmd = String(options.cmd || process.env.ARIS_CU_MCP_SERVER_CMD || 'python3 main.py').trim();
  if (!cmd) throw new Error('mcp_server_cmd_missing');
  return cmd;
}

function resolveCwd(options = {}) {
  const explicit = String(options.cwd || process.env.ARIS_CU_MCP_SERVER_CWD || '').trim();
  if (explicit) {
    if (path.isAbsolute(explicit)) return explicit;
    return path.resolve(process.cwd(), explicit);
  }
  return path.resolve(process.cwd(), 'local/mcp-computer-use-server');
}

function resolveTimeoutMs(options = {}) {
  return clampInt(options.timeoutMs || process.env.ARIS_CU_MCP_TIMEOUT_MS, 1000, 180000, 30000);
}

class StdioMcpClient {
  constructor({ cmd, cwd, env, context = null }) {
    this.cmd = cmd;
    this.cwd = cwd;
    this.env = env;
    this.context = context;
    this.proc = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.idCounter = 1;
    this.initialized = false;
    this.initializing = null;
    this.exited = false;
  }

  log(message) {
    if (this.context?.log) {
      this.context.log(`[computer-use/mcp] ${message}`);
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`[computer-use/mcp] ${message}`);
  }

  ensureProcess() {
    if (this.proc && !this.exited) return;

    this.proc = spawn(this.cmd, {
      cwd: this.cwd,
      env: this.env,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.exited = false;

    this.proc.stdout.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
      this.drainBuffer();
    });

    this.proc.stderr.on('data', (chunk) => {
      const text = String(chunk || '').trim();
      if (!text) return;
      if (this.context?.log) this.context.log(`[computer-use/mcp/stderr] ${text}`);
    });

    this.proc.on('error', (err) => {
      this.rejectAllPending(new Error(`mcp_process_error:${err.message}`));
    });

    this.proc.on('exit', (code, signal) => {
      this.exited = true;
      this.initialized = false;
      this.initializing = null;
      const reason = `mcp_process_exit:${code ?? 'null'}:${signal || 'none'}`;
      this.rejectAllPending(new Error(reason));
    });
  }

  rejectAllPending(err) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }

  drainBuffer() {
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;

      const header = this.buffer.slice(0, headerEnd).toString('utf8');
      const match = header.match(/content-length\s*:\s*(\d+)/i);
      if (!match) {
        this.buffer = Buffer.alloc(0);
        this.rejectAllPending(new Error('mcp_invalid_header_missing_content_length'));
        return;
      }

      const length = Number(match[1]);
      const total = headerEnd + 4 + length;
      if (this.buffer.length < total) return;

      const bodyBuf = this.buffer.slice(headerEnd + 4, total);
      this.buffer = this.buffer.slice(total);

      let message;
      try {
        message = JSON.parse(bodyBuf.toString('utf8'));
      } catch (err) {
        this.rejectAllPending(new Error(`mcp_invalid_json:${err.message}`));
        return;
      }

      if (message && Object.prototype.hasOwnProperty.call(message, 'id')) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);

        if (message.error) {
          const msg = String(message.error.message || 'mcp_error');
          const code = Number(message.error.code || 0);
          pending.reject(new Error(`mcp_rpc_error:${code}:${msg}`));
          continue;
        }

        pending.resolve(message.result);
      }
    }
  }

  writeMessage(message) {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
    this.proc.stdin.write(header);
    this.proc.stdin.write(body);
  }

  request(method, params = {}, timeoutMs = 30000) {
    this.ensureProcess();
    const id = this.idCounter++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp_timeout:${method}:${timeoutMs}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.writeMessage({
          jsonrpc: '2.0',
          id,
          method,
          params
        });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async ensureInitialized(timeoutMs = 30000) {
    if (this.initialized) return;
    if (this.initializing) return this.initializing;

    this.initializing = (async () => {
      await this.request('initialize', {
        protocolVersion: '2025-11-05',
        clientInfo: {
          name: 'schoolbot-v2',
          version: '0.1.0'
        }
      }, timeoutMs);
      this.initialized = true;
    })();

    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  async callTool(name, args = {}, options = {}) {
    const timeoutMs = resolveTimeoutMs(options);
    await this.ensureInitialized(timeoutMs);
    const result = await this.request('tools/call', {
      name,
      arguments: args
    }, timeoutMs);

    if (result && result.isError) {
      const reason = result?.structuredContent?.error || result?.content?.[0]?.text || 'mcp_tool_error';
      throw new Error(String(reason));
    }

    return result?.structuredContent ?? result;
  }

  async listTools(options = {}) {
    const timeoutMs = resolveTimeoutMs(options);
    await this.ensureInitialized(timeoutMs);
    const result = await this.request('tools/list', {}, timeoutMs);
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async close() {
    if (!this.proc || this.exited) return;

    await new Promise((resolve) => {
      const done = () => resolve();
      this.proc.once('exit', done);
      try {
        this.proc.kill('SIGTERM');
      } catch {
        resolve();
      }
      setTimeout(resolve, 500);
    });
  }
}

let singleton = null;
let singletonKey = '';

function buildClientOptions(options = {}, context = null) {
  const cmd = resolveCommand(options);
  const cwd = resolveCwd(options);
  const env = {
    ...process.env,
    ...(options.env && typeof options.env === 'object' ? options.env : {})
  };
  return { cmd, cwd, env, context };
}

function buildKey(opts) {
  return `${opts.cmd}@@${opts.cwd}`;
}

async function getClient(options = {}, context = null) {
  const opts = buildClientOptions(options, context);
  const key = buildKey(opts);

  if (singleton && key !== singletonKey) {
    await singleton.close();
    singleton = null;
    singletonKey = '';
  }

  if (!singleton) {
    singleton = new StdioMcpClient(opts);
    singletonKey = key;
  } else if (context) {
    singleton.context = context;
  }

  return singleton;
}

async function callMcpTool(name, args = {}, options = {}, context = null) {
  const client = await getClient(options, context);
  return client.callTool(name, args, options);
}

async function listMcpTools(options = {}, context = null) {
  const client = await getClient(options, context);
  return client.listTools(options);
}

async function shutdownMcpClient() {
  if (!singleton) return;
  await singleton.close();
  singleton = null;
  singletonKey = '';
}

process.on('exit', () => {
  if (singleton) {
    try {
      singleton.close();
    } catch {
      // no-op
    }
  }
});

module.exports = {
  callMcpTool,
  listMcpTools,
  shutdownMcpClient,
  getClient
};
