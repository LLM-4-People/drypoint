/**
 * Protocol client: the only place that turns a command name into bytes on the
 * wire and back into a parsed reply.
 */

import { buildCommand, commandTimeout, replyOpcode } from './commands.js';
import { REPLY_PARSERS } from './replies.js';
import { createLogger } from '../core/log.js';

const log = createLogger('protocol.client');

export class ProtocolClient {
  constructor(session) {
    this.session = session;
  }

  /** Send a command and return its raw reply payload. */
  async request(name, params = {}, { signal } = {}) {
    const bytes = buildCommand(name, params);
    const reply = replyOpcode(name, params);
    const frame = await this.session.exchange(bytes, reply, { timeoutMs: commandTimeout(name), signal });
    return frame.data;
  }

  /** Send a command that has no reply, bounded by the session's write deadline. */
  async send(name, params = {}, options) {
    await this.session.write(buildCommand(name, params), options);
  }

  /** Decode one raw reply payload with the parser registered for its opcode. */
  #decode(name, params, data) {
    const reply = replyOpcode(name, params);
    const parser = REPLY_PARSERS[reply];
    return parser ? parser(data) : data;
  }

  /** Send a command and decode its reply with the registered parser. */
  async query(name, params = {}, options) {
    return this.#decode(name, params, await this.request(name, params, options));
  }

  /**
   * Optional probe: unsupported commands and timeouts are normal, everything
   * else (connection loss, protocol errors) is a real failure.
   */
  async tryRequest(name, params = {}, options) {
    try {
      return await this.request(name, params, options);
    } catch (error) {
      if (error.unsupported || error.timeout) {
        log.debug(`optional command skipped: ${name}`, { message: error.message });
        return null;
      }
      throw error;
    }
  }

  /** Optional probe with the same decoding as query(); null when unanswered. */
  async tryQuery(name, params = {}, options) {
    const data = await this.tryRequest(name, params, options);
    return data === null ? null : this.#decode(name, params, data);
  }
}
