import { NotifyMessage, ResponseMessage, StreamChunkMessage, StreamEndMessage, StreamStartMessage } from './types.js';
import { generateMessageId } from './utils.js';
import { GatewayTransport } from './transport.js';

export class RelayOutbound {
  constructor(private readonly transport: GatewayTransport) {}

  async sendResponse(clientId: string, id: string, result: Record<string, unknown>): Promise<void> {
    const msg: ResponseMessage = { id, type: 'response', result };
    await this.transport.sendLayer2(clientId, msg);
  }

  async sendError(clientId: string, id: string, code: string, message: string): Promise<void> {
    const msg: ResponseMessage = { id, type: 'response', error: { code, message } };
    await this.transport.sendLayer2(clientId, msg);
  }

  async sendStreamStart(clientId: string, id: string, method: string): Promise<void> {
    const msg: StreamStartMessage = { id, type: 'stream_start', method };
    await this.transport.sendLayer2(clientId, msg);
  }

  async sendStreamChunk(clientId: string, id: string, seq: number, data: Record<string, unknown>): Promise<void> {
    const msg: StreamChunkMessage = { id, type: 'stream_chunk', seq, data };
    await this.transport.sendLayer2(clientId, msg);
  }

  async sendStreamEnd(clientId: string, id: string, seq: number): Promise<void> {
    const msg: StreamEndMessage = { id, type: 'stream_end', seq };
    await this.transport.sendLayer2(clientId, msg);
  }

  async sendNotify(clientId: string, event: string, data: Record<string, unknown>): Promise<void> {
    const msg: NotifyMessage = { id: generateMessageId(), type: 'notify', event, data };
    await this.transport.sendLayer2(clientId, msg);
  }
}
