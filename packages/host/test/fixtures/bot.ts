// A headless client in its own worker thread (Spike 7): it joins with the token it is given,
// drives full throttle and counts snapshots, so the relay cost measured on the main thread excludes
// the client's own work.
import { parentPort, workerData } from 'node:worker_threads';
import { NetClient } from '@conduit/net-client';
import { type FixtureInput, game } from './game.ts';

interface BotData {
  url: string;
  token: string;
  name: string;
}

const port = parentPort;
if (port === null) throw new Error('bot.ts runs in a Worker');
const data = workerData as BotData;

const client = new NetClient({
  url: data.url,
  game,
  token: data.token,
  displayName: data.name,
  autoReconnect: false,
  log: () => undefined,
  sampleInput: (frame) => {
    (frame as FixtureInput).throttle = 20;
  },
});
let snapshots = 0;
client.on('snapshot', () => snapshots++);
client.on('state', (state) => {
  if (state === 'Playing') port.postMessage({ t: 'playing' });
});
const frames = setInterval(() => client.update(), 16);
port.on('message', (msg: { t: string }) => {
  if (msg.t === 'reset') {
    snapshots = 0;
    return;
  }
  if (msg.t === 'stop') {
    const stats = client.stats();
    port.postMessage({ t: 'stats', snapshots, bytesIn: stats.bytesIn, bytesOut: stats.bytesOut });
    clearInterval(frames);
    client.disconnect();
    setTimeout(() => process.exit(0), 50);
  }
});
await client.connect();
