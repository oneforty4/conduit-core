// Records the URL of every module the loader resolves, for test/module-graph.test.ts
// (docs/render.md 10.1):
//
//   node --import ./test/trace-loader.mjs <entry>
//
// On exit the URLs are written as a JSON array to the file named by CONDUIT_TRACE_OUT, or printed to
// stdout when it is unset. Resolve hooks see static and dynamic imports as well as require() calls.
// Uses the synchronous in-thread `module.registerHooks` (Node >= 22.15) and otherwise
// `module.register` with an async hook on the loader thread that reports over a MessagePort.
import { writeFileSync } from 'node:fs';
import * as nodeModule from 'node:module';

const urls = new Set();

if (typeof nodeModule.registerHooks === 'function') {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      urls.add(result.url);
      return result;
    },
  });
} else {
  const { port1, port2 } = new MessageChannel();
  port1.on('message', (url) => urls.add(url));
  port1.unref();
  const hooks = `
    let port;
    export function initialize(data) { port = data.port; }
    export async function resolve(specifier, context, nextResolve) {
      const result = await nextResolve(specifier, context);
      port.postMessage(result.url);
      return result;
    }`;
  nodeModule.register(`data:text/javascript,${encodeURIComponent(hooks)}`, {
    data: { port: port2 },
    transferList: [port2],
  });
}

process.on('exit', () => {
  const json = JSON.stringify([...urls]);
  const out = process.env.CONDUIT_TRACE_OUT;
  if (out) writeFileSync(out, json);
  else process.stdout.write(`${json}\n`);
});
