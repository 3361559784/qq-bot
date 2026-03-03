/**
 * v2 message contract
 * @typedef {Object} MessageRequest
 * @property {string} content
 * @property {string} channel
 * @property {string} user_id
 * @property {string} [context_id]
 * @property {Array<Object>} [attachments]
 * @property {Object} [metadata]
 */

/**
 * @typedef {Object} ToolCall
 * @property {string} tool
 * @property {Object} input
 * @property {Object|string|null} output
 * @property {'success'|'failed'|'skipped'} status
 * @property {string|null} error
 * @property {number} duration_ms
 */

/**
 * @typedef {Object} ComputerUseStep
 * @property {number} index
 * @property {string} action
 * @property {'success'|'failed'|'skipped'} status
 * @property {number} duration_ms
 * @property {number} [retry_count]
 * @property {string|null} [error]
 * @property {string} [screenshot_ref]
 * @property {Object|string|null} [output]
 */

/**
 * @typedef {Object} ComputerUseJob
 * @property {string} id
 * @property {string} request_id
 * @property {string} user_id
 * @property {string} context_id
 * @property {string} objective
 * @property {'queued'|'leased'|'running'|'waiting_confirmation'|'completed'|'failed'|'cancelled'} status
 * @property {string} confirm_mode
 * @property {number} confirm_every_steps
 * @property {number} step_max_retry
 * @property {number} max_steps
 * @property {number} steps_executed
 * @property {number} confirm_round
 * @property {Array<ComputerUseStep>} steps
 * @property {string} [summary]
 * @property {Object|string|null} [output]
 * @property {string|null} [error]
 * @property {string} [last_screenshot_ref]
 * @property {'mcp_stdio'|'http_agent'|'hybrid'} [transport]
 * @property {'openai_byok'|'chatgpt_plus_relay_poc'|'unknown'|string} [provider]
 * @property {number} [provider_attempts]
 * @property {Array<{provider:string, code:string, message:string}>} [provider_error_chain]
 */

/**
 * @typedef {Object} ComputerUseAgentPollRequest
 * @property {string} agent_id
 */

/**
 * @typedef {Object} ComputerUseAgentPollResponse
 * @property {boolean} success
 * @property {ComputerUseJob|null} job
 */

/**
 * @typedef {Object} ComputerUseProviderResult
 * @property {'openai_byok'|'chatgpt_plus_relay_poc'|'unknown'|string} provider
 * @property {number} provider_attempts
 * @property {boolean} provider_fallback_used
 * @property {Array<{provider:string, code:string, message:string}>} provider_error_chain
 * @property {boolean} [experimental]
 */

/**
 * @typedef {Object} McpToolCallMeta
 * @property {'mcp_stdio'|'http_agent'|'hybrid'} transport
 * @property {'openai_byok'|'chatgpt_plus_relay_poc'|'unknown'|string} provider
 * @property {number} provider_attempts
 * @property {boolean} provider_fallback_used
 */

/**
 * @typedef {Object} SafetyDecision
 * @property {'pass'|'degrade'|'refuse'} action
 * @property {string} category
 * @property {string} reason_code
 * @property {number} confidence
 * @property {string} [source]
 * @property {boolean} [retryable]
 * @property {number} [clarify_round]
 */

/**
 * @typedef {Object} MessageResponse
 * @property {string} id
 * @property {string} content
 * @property {'alice'|'professional'} persona
 * @property {Array<ToolCall>} tool_calls
 * @property {SafetyDecision} safety
 * @property {Array<string>} memory_refs
 * @property {{prompt_tokens:number, completion_tokens:number, total_tokens:number}} usage
 * @property {number} latency_ms
 */

module.exports = {};
