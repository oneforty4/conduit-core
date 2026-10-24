import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const require = createRequire(`${root}/examples/sandbox/package.json`);
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/tmp/conduit-improvements-browsers';
const { createServer } = await import(require.resolve('vite'));
const { chromium, firefox, webkit } = require('@playwright/test');
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/tmp/conduit-improvements-browsers';
const original = process.env.CONDUIT_ORIGINAL_TREE ?? '/tmp/conduit-original-baseline';
const CONSUMER = String.raw`
import {defineGame,defineComponent,defineInput,defineSystem,f,GridWorld} from '/packages/game/src/index.ts';
export function consumer(kind){
 const fields=kind==='vehicle'?{position:f.f32,throttle:f.f32,revision:f.u32}:kind==='character'?{position:f.f32,moving:f.bool,revision:f.u32}:{items:f.array(f.u16,32),revision:f.u32};
 const State=defineComponent('Measured'+kind,fields);
 const Input=defineInput({tick:f.u32,value:f.f32,revision:f.u32});
 const commands=[];
 const game=defineGame({id:'measured-'+kind,name:'Measured '+kind,protocolVersion:1,seed:42,tickRate:60,snapshotEvery:3,components:[State],events:[],messages:[],input:Input,world:seed=>new GridWorld({cellSize:64,cols:1,rows:1,wantedDepth:0,worldSeed:seed}),systems:[defineSystem('measuredRule','sim',ctx=>{
  for(const entity of ctx.world.query(State)){
   const state=ctx.world.write(entity,State);const input=ctx.inputs(0);
   if(kind==='inventory'){for(const command of commands.splice(0)){state.items.push(command.item);state.revision=command.revision;}}
   else if(kind==='vehicle'){if(input){state.throttle=input.value;state.revision=input.revision;}state.position+=state.throttle*ctx.dt;}
   else{if(input){state.moving=input.value!==0;state.revision=input.revision;}if(state.moving)state.position+=ctx.dt;}
  }
 })]});
 return {game,State,commands};
}`;
const WORKER = String.raw`
import {consumer} from '/__measurement-consumer.ts';
import {World,Simulation} from '/packages/sim/src/index.ts';
import {Rng} from '/packages/math/src/index.ts';
import {ByteWriter,encodeSnapshot,REGION_IDX_NONE} from '/packages/protocol/src/index.ts';
let model,world,sim,entity,kind,queue=[],held,start=0,timer,next=0,overflows=0,stale=0,lastAccepted=0,capacity=6;
function sendSnapshot(tick){const component=model.game.registry.componentId?model.game.registry.componentId(model.State):model.State.id;
 const data={header:{serverTick:tick,serverTimeMs:Math.floor(performance.now()-start),baselineTick:Math.max(0,tick-3),lastInputTick:held?.tick??0,lastInputSeq:0,flags:0},regions:[],creates:tick===3?[{entity,regionIdx:REGION_IDX_NONE,components:[{id:component,value:world.get(entity,model.State)}]}]:[],updates:tick===3?[]:[{entity,components:[{id:component,value:world.get(entity,model.State)}],removed:[]}],destroys:[]};
 const bytes=new ByteWriter();encodeSnapshot(bytes,model.game.registry,data);const payload=bytes.finish?bytes.finish():bytes.view().slice();postMessage({snapshot:payload,serverTick:tick,serverTimeMs:performance.now()-start,overflows,stale});}
function tick(){const target=Math.floor((performance.now()-start)*60/1000+1e-6);let work=0;
 while(world.tick<target&&work++<10){const tick=world.tick+1;while(queue.length&&queue[0].tick<tick){queue.shift();stale++;}if(queue[0]?.tick===tick)held=queue.shift();sim.inputFrames[0]=held;sim.step(tick);if(tick%3===0)sendSnapshot(tick);}
 next=world.tick+1;timer=setTimeout(tick,Math.max(1,start+next*1000/60-performance.now()));}
onmessage=event=>{const message=event.data;
 if(message.init){kind=message.kind;capacity=message.current?35:6;model=consumer(kind);world=new World(model.game.registry);entity=world.create();world.add(entity,model.State);sim=new Simulation({world,seed:42,tickRate:60,regionRng:()=>new Rng(42),regions:{regionOf(){},entitiesIn:()=>[],active:()=>[],def(){},migrate:()=> 'notMember'},spatial:{queryRadius:(_i,_p,_r,out)=>out,queryAABB:(_i,_a,_b,out)=>out,queryRadiusAcross:(_i,_p,_r,out)=>out,nearest(){}}});model.game.systems.forEach(system=>sim.register(system));start=performance.now();postMessage({ready:true,entity});timer=setTimeout(tick,1000/60);}
 else if(message.input){for(const frame of message.input){if(frame.tick<=lastAccepted)continue;if(message.current&&(frame.tick>world.tick+32||frame.tick<world.tick-2))continue;queue.push(frame);lastAccepted=frame.tick;if(queue.length>capacity){queue.shift();overflows++;}}}
 else if(message.command)model.commands.push(message.command);
 else if(message.ping!==undefined)postMessage({pong:message.ping,serverTimeMs:performance.now()-start,serverTick:world.tick});
 else if(message.stop){clearTimeout(timer);postMessage({stopped:true});close();}
};`;
const CLIENT = String.raw`
import {consumer} from '/__measurement-consumer.ts';
import {InputSender,NetClock,ReplicaWorld,toU32Ms} from '/packages/net-client/src/index.ts';
import {ByteReader,decodeSnapshot} from '/packages/protocol/src/index.ts';
globalThis.measureScenario=async function(kind,fps,current,prediction=false){
 const model=consumer(kind),worker=new Worker('/__measurement-worker.ts',{type:'module'}),clock=new NetClock({now:()=>performance.now()});clock.configure(60,3);
 const replica=new ReplicaWorld(model.game.registry,model.game.components,{tickRate:60,snapshotEvery:3});
 const times=new Map(),latencies=[],samples=[],timers=[];let control={value:0,revision:0},entity=0,previousTick=0,backwards=0,maxExtraLead=0,overflows=0,stale=0,presentBackwards=0,priorRevision=0,done=false;
 const after=(fn,ms)=>{const handle=setTimeout(()=>{if(!done)fn();},ms);timers.push(handle);return handle;};
 const send=message=>after(()=>worker.postMessage(message),10);
 let driver;const correctionMagnitudes=[];let predictedSamples=0;const commandIds=[];
 if(current&&prediction){const {PredictionDriver}=await import('/packages/net-client/src/index.ts');
  driver=new PredictionDriver({inputSchema:model.game.input,tickRate:60,copyCommand:command=>({...command}),adapter:{
   createState:()=>model.State.create(),copyState:(source,out)=>{model.State.copy(out,source);},
   readAuthoritative:(view,out)=>{const state=replica.read(view.entity,model.State);if(!state)return{coherent:false,authoritativeTick:view.serverTick,boundaryKey:'spawn',regionId:'cell/0_0',heldInput:undefined};model.State.copy(out,state);return{coherent:true,authoritativeTick:view.serverTick,boundaryKey:'spawn',regionId:'cell/0_0',heldInput:kind==='inventory'?undefined:{tick:view.ackedTick,value:kind==='vehicle'?state.throttle:state.moving?1:0,revision:state.revision},commandOutcomes:kind==='inventory'?commandIds.filter(entry=>entry.revision<=state.revision).map(entry=>({id:entry.id,outcome:'confirmed'})):[]};},
   step:(state,context)=>{if(kind==='inventory'){for(const command of context.commands){state.items.push(command.item);state.revision=command.revision;}}else if(kind==='vehicle'){if(context.input){state.throttle=context.input.value;state.revision=context.input.revision;}state.position+=state.throttle*context.dt;}else{if(context.input){state.moving=context.input.value!==0;state.revision=context.input.revision;}if(state.moving)state.position+=context.dt;}},
   equals:(expected,actual)=>{const magnitude=kind==='inventory'?Math.abs(expected.items.length-actual.items.length):Math.abs(expected.position-actual.position);if(magnitude>1e-5&&correctionMagnitudes.length<512)correctionMagnitudes.push(magnitude);return magnitude<=1e-5&&expected.revision===actual.revision;},
   sample:(_previous,current,_alpha,out)=>{model.State.copy(out,current);},
  }});
 }
 const sender=new InputSender(model.game.input,message=>{const tick=message.frames.at(-1).tick;driver?.recordInput(message.frames.at(-1));if(tick<previousTick)backwards++;previousTick=tick;maxExtraLead=Math.max(maxExtraLead,tick-clock.inputTick());send({input:message.frames.map(frame=>model.game.input.copy(frame,model.game.input.create())),current});},clock,frame=>{frame.value=control.value;frame.revision=control.revision;});
 const ready=new Promise(resolve=>{worker.onmessage=event=>{const message=event.data;if(message.ready){entity=message.entity;clock.addSample(0,0,performance.now());resolve();}else after(()=>{if(message.snapshot){const decoded=decodeSnapshot(new ByteReader(message.snapshot),model.game.registry);replica.applySnapshot(decoded);driver?.reconcile({serverTick:decoded.header.serverTick,ackedTick:decoded.header.lastInputTick,ackedSeq:0,entity,authoritative:replica.get(entity),replica,pending:{length:0,at(){throw Error('empty');}}});clock.onSnapshotArrival(message.serverTimeMs,message.serverTick,performance.now());overflows=message.overflows;stale=message.stale;}else if(message.pong!==undefined)clock.onPong(message.pong,message.serverTimeMs,message.serverTick,performance.now());},10);};});
 worker.postMessage({init:true,kind,current});await ready;
 const started=performance.now();
 const timerWake=()=>{sender.tick(performance.now());after(timerWake,current?Math.max(1,clock.nextInputDeadline(sender.lastSentTick)-performance.now()):16);};after(timerWake,current?1:16);
 let frameNumber=0;
 const render=()=>{const now=performance.now();if(driver?.ready){const before=driver.tick;driver.sample(driver.tick,model.State.create());if(before!==driver.tick)throw Error('Presentation advanced prediction');predictedSamples++;}if(current)sender.tick(now);clock.update(now);const output=model.State.create();const sampled=replica.sample(entity,model.State,clock.renderTick(),output);if(sampled){const revision=sampled.revision;if(revision<priorRevision)presentBackwards++;priorRevision=Math.max(priorRevision,revision);const inputTime=times.get(revision);if(inputTime!==undefined&&!samples.includes(revision)){samples.push(revision);latencies.push(now-inputTime);}}frameNumber++;after(render,Math.max(1,started+frameNumber*1000/fps-performance.now()));};after(render,0);
 for(let index=1;index<=6;index++)after(()=>{times.set(index,performance.now());control={value:index%2?1:0,revision:index};if(kind==='inventory'){const id='command-'+index;commandIds.push({id,revision:index});driver?.recordCommand(id,clock.inputTick(),{item:index,revision:index});send({command:{item:index,revision:index}});}},80+(index-1)*230);
 const ping=()=>{send({ping:toU32Ms(performance.now())});after(ping,500);};after(ping,0);
 after(()=>{const until=performance.now()+120;while(performance.now()<until){}},650);
 await new Promise(resolve=>setTimeout(resolve,1800));done=true;timers.forEach(clearTimeout);worker.terminate();
 return{kind,fps,sentTicks:previousTick,backwards,maxExtraLeadTicks:maxExtraLead,inputOverflow:overflows,staleInputs:stale,presentationBackwards:presentBackwards,presentedRevisions:samples,latenciesMs:latencies,clockSnaps:clock.snaps,renderedFrames:frameNumber,elapsedMs:performance.now()-started,prediction:driver?.stats(),correctionMagnitudes,predictedSamples};
};`;
async function serverFor(base) {
  const files = {
    '/__measurement-consumer.ts': CONSUMER,
    '/__measurement-worker.ts': WORKER,
    '/__measurement-client.ts': CLIENT,
  };
  const server = await createServer({
    root: base,
    configFile: false,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, fs: { allow: [base] } },
    plugins: [
      {
        name: 'measurement',
        resolveId: (id) => (id in files ? '\0' + id : undefined),
        load: (id) => (id[0] === '\0' ? files[id.slice(1)] : undefined),
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== '/timing.html') return next();
            res.setHeader('Content-Type', 'text/html');
            res.end(
              '<html><body><script type="module" src="/__measurement-client.ts"></script></body></html>',
            );
          });
        },
      },
    ],
  });
  await server.listen();
  return { server, url: 'http://127.0.0.1:' + server.httpServer.address().port };
}
const results = [];
const browserVersions = {};
const expectedRuns =
  (process.env.CONDUIT_BROWSER_ENGINE ? 1 : 3) *
  (process.env.CONDUIT_BROWSER_TREE ? 1 : 2) *
  (process.env.CONDUIT_BROWSER_KIND ? 1 : 3) *
  (process.env.CONDUIT_BROWSER_FPS ? 1 : 4);
let failed = false;
try {
  for (const [engineName, engine] of [
    ['chromium', chromium],
    ['firefox', firefox],
    ['webkit', webkit],
  ].filter(
    ([name]) => !process.env.CONDUIT_BROWSER_ENGINE || name === process.env.CONDUIT_BROWSER_ENGINE,
  )) {
    const browser = await engine.launch({
      headless: true,
      ...(engineName === 'chromium' ? { args: ['--use-gl=angle', '--use-angle=swiftshader'] } : {}),
    });
    browserVersions[engineName] = browser.version();
    try {
      for (const [tree, base, current] of [
        ['baseline', original, false],
        ['current', root, true],
      ].filter(
        ([tree]) => !process.env.CONDUIT_BROWSER_TREE || tree === process.env.CONDUIT_BROWSER_TREE,
      )) {
        const { server, url } = await serverFor(base);
        try {
          for (const kind of process.env.CONDUIT_BROWSER_KIND
            ? [process.env.CONDUIT_BROWSER_KIND]
            : ['vehicle', 'character', 'inventory'])
            for (const fps of process.env.CONDUIT_BROWSER_FPS
              ? [Number(process.env.CONDUIT_BROWSER_FPS)]
              : [30, 60, 120, 144]) {
              const page = await browser.newPage();
              const errors = [];
              page.on('pageerror', (error) => errors.push(error.message));
              try {
                await page.goto(url + '/timing.html');
                await page.waitForFunction(() => typeof globalThis.measureScenario === 'function');
                const result = await page.evaluate(
                  ({ kind, fps, current, prediction }) =>
                    globalThis.measureScenario(kind, fps, current, prediction),
                  {
                    kind,
                    fps,
                    current,
                    prediction: process.env.CONDUIT_BROWSER_PREDICTION === '1',
                  },
                );
                if (errors.length) throw Error(errors.join('; '));
                if (result.presentedRevisions.length !== 6 || result.latenciesMs.length !== 6)
                  throw Error('Expected all six presented revisions');
                if (
                  current &&
                  (result.backwards !== 0 ||
                    result.inputOverflow !== 0 ||
                    result.presentationBackwards !== 0)
                )
                  throw Error('Current scheduler correctness gate failed');
                results.push({ engine: engineName, tree, ...result });
                console.log(engineName, tree, kind, fps, 'samples', result.latenciesMs.length);
              } finally {
                await page.close();
              }
            }
        } finally {
          await server.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
} catch (error) {
  failed = true;
  throw error;
} finally {
  writeFileSync(
    process.env.CONDUIT_BROWSER_OUTPUT ??
      `${root}/artifacts/improvements/browser-timing-comparison.json`,
    JSON.stringify(
      {
        version: 1,
        status: failed ? 'failed' : results.length === expectedRuns ? 'complete' : 'partial',
        expectedRuns,
        completedRuns: results.length,
        browserVersions,
        latencyEvaluation: { mode: 'descriptive', tolerance: null },
        correctnessGates: [
          'all six input revisions presented',
          'no current backwards input/presentation ticks',
          'no current input queue overflow',
        ],
        environment: { node: process.version, platform: process.platform, arch: process.arch },
        inputs: {
          durationMs: 1800,
          seed: 42,
          simulationHz: 60,
          snapshotEvery: 3,
          oneWayLatencyMs: 10,
          clientMainThreadStall: { atMs: 650, durationMs: 120 },
          controlEvents: 6,
        },
        scope:
          'Actual browser timers and independent browser worker simulation, forced presentation cadence; not physical display refresh, full NetClient/Session admission/reconnect, or production headroom.',
        results,
      },
      null,
      2,
    ) + '\n',
  );
}
