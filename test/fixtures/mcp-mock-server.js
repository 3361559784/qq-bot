#!/usr/bin/env node

const modeArg = process.argv.find((x) => x.startsWith('--mode='));
const mode = modeArg ? modeArg.slice('--mode='.length) : 'normal';

let buffer = Buffer.alloc(0);
let hasCrashed = false;

function writeMessage(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  process.stdout.write(header);
  process.stdout.write(body);
}

function success(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result });
}

function error(id, code, message) {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

function toolsList() {
  return [
    { name: 'screenshot', inputSchema: { type: 'object', properties: {} } },
    { name: 'click', inputSchema: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' } } } },
    { name: 'double_click', inputSchema: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' } } } },
    { name: 'right_click', inputSchema: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' } } } },
    { name: 'type', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
    { name: 'hotkey', inputSchema: { type: 'object', properties: { keys: { type: 'array', items: { type: 'string' } } } } },
    { name: 'scroll', inputSchema: { type: 'object', properties: { dx: { type: 'integer' }, dy: { type: 'integer' } } } },
    { name: 'wait', inputSchema: { type: 'object', properties: { ms: { type: 'integer' } } } },
    { name: 'run_task', inputSchema: { type: 'object', properties: { objective: { type: 'string' } }, required: ['objective'] } },
  ];
}

function handleCall(id, params) {
  const name = String(params?.name || '');
  const args = params?.arguments || {};

  if (name !== 'run_task') {
    return success(id, {
      isError: false,
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { ok: true },
    });
  }

  const objective = String(args.objective || '');

  if (objective.includes('force_mcp_fail')) {
    return success(id, {
      isError: true,
      content: [{ type: 'text', text: 'simulated_mcp_failure' }],
      structuredContent: { error: 'simulated_mcp_failure' },
    });
  }

  if (objective.includes('plus_fallback')) {
    return success(id, {
      isError: false,
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: {
        success: true,
        status: 'completed',
        summary: 'relay fallback executed',
        steps_executed: 2,
        provider: 'chatgpt_plus_relay_poc',
        provider_mode: 'relay_poc',
        provider_attempts: 2,
        provider_fallback_used: true,
        provider_error_chain: [
          { provider: 'openai_byok', model: 'openai/gpt-5-nano', code: 'model_not_found', message: '404 model' },
          { provider: 'openai_byok', model: 'openai/gpt-4.1-mini', code: 'rate_limited', message: '429' }
        ],
        planner_model_selected: '',
        planner_model_attempts: 2,
        last_screenshot_ref: 'inline://mock2'
      },
    });
  }

  if (objective.includes('model_fallback')) {
    return success(id, {
      isError: false,
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: {
        success: true,
        status: 'completed',
        summary: 'model fallback executed',
        steps_executed: 1,
        provider: 'openai_byok',
        provider_mode: 'github_models',
        provider_attempts: 1,
        provider_fallback_used: false,
        provider_error_chain: [
          { provider: 'openai_byok', model: 'openai/gpt-5-nano', code: 'model_not_found', message: '404 model' }
        ],
        planner_model_selected: 'openai/gpt-4.1-mini',
        planner_model_attempts: 2,
        last_screenshot_ref: 'inline://mock-model-fallback'
      },
    });
  }

  const waiting = objective.includes('waiting_confirmation');
  return success(id, {
    isError: false,
    content: [{ type: 'text', text: 'ok' }],
    structuredContent: {
      success: true,
      status: waiting ? 'waiting_confirmation' : 'completed',
      summary: waiting ? 'need confirm' : 'mcp completed',
      steps_executed: waiting ? 5 : 1,
      confirm_round: waiting ? 1 : 0,
      provider: 'openai_byok',
      provider_mode: 'github_models',
      provider_attempts: 1,
      provider_fallback_used: false,
      provider_error_chain: [],
      planner_model_selected: 'openai/gpt-5-nano',
      planner_model_attempts: 1,
      last_screenshot_ref: 'inline://mock1'
    },
  });
}

function handleMessage(message) {
  const id = message.id;

  if (mode === 'timeout') {
    return;
  }

  if (mode === 'crash' && !hasCrashed) {
    hasCrashed = true;
    process.stderr.write('mock crash once\n');
    process.exit(13);
    return;
  }

  if (mode === 'stderr-noise') {
    process.stderr.write('mock stderr log\n');
  }

  switch (message.method) {
    case 'initialize':
      success(id, {
        protocolVersion: '2025-11-05',
        serverInfo: { name: 'mock', version: '0.0.1' },
        capabilities: { tools: {} },
      });
      return;
    case 'tools/list':
      success(id, { tools: toolsList() });
      return;
    case 'tools/call':
      handleCall(id, message.params || {});
      return;
    case 'ping':
      success(id, { ok: true });
      return;
    default:
      error(id, -32601, 'method_not_found');
  }
}

function drain() {
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;

    const header = buffer.slice(0, headerEnd).toString('utf8');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = Buffer.alloc(0);
      return;
    }

    const length = Number(match[1]);
    const total = headerEnd + 4 + length;
    if (buffer.length < total) return;

    const body = buffer.slice(headerEnd + 4, total).toString('utf8');
    buffer = buffer.slice(total);

    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      continue;
    }
    handleMessage(msg);
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
  drain();
});

process.stdin.on('end', () => {
  process.exit(0);
});
