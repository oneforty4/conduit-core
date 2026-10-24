import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { character, fixture, inventory, vehicle } from './consumers.ts';
import { runScenario } from './runner.ts';

it('emits reproducible JSON artifacts when explicitly requested', () => {
  const runs = [
    runScenario(fixture('vehicle'), vehicle),
    runScenario(fixture('character'), character),
    runScenario(fixture('inventory'), inventory),
  ];
  for (const run of runs) expect(run.trace.length).toBeGreaterThan(0);
  const destination = process.env['CONDUIT_SCENARIO_ARTIFACT'];
  if (destination)
    writeFileSync(resolve(destination), JSON.stringify({ version: 1, runs }, null, 2) + '\n');
});
