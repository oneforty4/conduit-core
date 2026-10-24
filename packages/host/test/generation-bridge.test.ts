import { MessageChannel } from 'node:worker_threads';
import { MemoryStore } from '@conduit/persist';
import { generationContract } from '../../persist/test/generation-contract.ts';
import { ProxyBlobStore } from '../src/proxy-blob-store.ts';
import { StoreBridge } from '../src/store-bridge.ts';
import type { StoreRequest, StoreResult } from '../src/port-protocol.ts';

generationContract('generation contract / worker bridge', async () => {
  const channel = new MessageChannel();
  const backing = new MemoryStore();
  const bridge = new StoreBridge(backing, channel.port1);
  const store = new ProxyBlobStore(channel.port2);
  channel.port1.on('message', (message: StoreRequest) => {
    void bridge.handle(message);
  });
  channel.port2.on('message', (message: StoreResult) => store.handleResult(message));
  return {
    store,
    close() {
      channel.port1.close();
      channel.port2.close();
    },
  };
});
