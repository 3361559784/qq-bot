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
 * @typedef {Object} SafetyDecision
 * @property {'pass'|'degrade'|'refuse'} action
 * @property {string} category
 * @property {string} reason_code
 * @property {number} confidence
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
