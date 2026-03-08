import { GatewayStatus } from './types.js';

export function computeHealthState(status: GatewayStatus): GatewayStatus['health'] {
  return status.health;
}
