import { createCompatibilityDescriptor } from '../../packages/protocol/src/index.ts';
const compatibility = createCompatibilityDescriptor('replay-example', {
  simulationRevision: 'example-v1',
  gameplayDigests: { rules: 'one' },
});
export const replayFactory = {
  async createRun() {
    let state = { inventory: [], selected: 0 };
    let disposed = false;
    let tick = 0;
    return {
      compatibility,
      stateSchemaHash: 0,
      capacity: 8,
      get tick() {
        return tick;
      },
      apply(action) {
        if (disposed) throw new Error('disposed');
        if (action.kind === 'external' && action.name === 'database-result')
          state.inventory.push(action.payload.item);
        else if (action.kind === 'message' && action.name === 'SelectItem')
          state.selected = action.payload.index;
        else throw new Error('Missing recorded command handler');
      },
      async step(next) {
        tick = next;
      },
      skip(count) {
        tick += count;
      },
      capture() {
        return structuredClone(state);
      },
      restore(checkpoint) {
        state = structuredClone(checkpoint);
      },
      dispose() {
        disposed = true;
      },
    };
  },
};
