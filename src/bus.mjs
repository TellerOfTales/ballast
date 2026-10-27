import { EventEmitter } from 'node:events';

// Everything the UI needs to hear about flows through here and out over SSE.
export const bus = new EventEmitter();
bus.setMaxListeners(100);

let stateTimer = null;
export function changed() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    bus.emit('event', { type: 'state' });
  }, 120);
}
