/**
 * @typedef {Object} LegacyQqEvent
 * @property {'message'|'message_sent'|'notice'|'poke'|string} event_type
 * @property {'private'|'group'|'none'} message_type
 * @property {string} user_id
 * @property {string|null} [group_id]
 * @property {string|null} [self_id]
 * @property {string} content
 * @property {string} raw_content
 * @property {Array<string>} mentions
 * @property {{id?:string|null}|null} reply_to
 * @property {Array<Object>} attachments
 * @property {Object} sender
 * @property {Object} raw_payload
 * @property {boolean} requires_response
 */

/**
 * v2 message contract
 * @typedef {Object} MessageRequest
 * @property {string} content
 * @property {string} channel
 * @property {string} user_id
 * @property {string} [context_id]
 * @property {Array<Object>} [attachments]
 * @property {Object} [metadata]
 * @property {Object} [metadata.roleplay_overlay]
 * @property {string} [metadata.trigger_source]
 * @property {string} [metadata.memory_policy]
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
 * @typedef {Object} CapabilityPlan
 * @property {'chat'|'capability'} mode
 * @property {Array<'weather'|'search'|'vision'|'draw'|'schedule'|'ocr'|'none'|string>} capabilities
 * @property {string} reason
 * @property {boolean} requires_clarification
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
 * @property {Object} [meta]
 * @property {'chat'|'identity_meta'|'capability'|'safety'} [meta.reply_mode]
 * @property {boolean} [meta.overlay_applied]
 * @property {Array<string>} [meta.memory_write_ids]
 */

module.exports = {};
