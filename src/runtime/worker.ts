import type { VerificationOptions, WorkerMessage } from '../shared/compatibility';

const parent = process.parentPort;
if (!parent) throw new Error('The runtime entry must be launched with utilityProcess.fork.');
const send = (message: WorkerMessage): void => parent.postMessage(message);
let started = false;
let completed = false;

parent.on('message', ({ data }: { data: { type?: string; options?: VerificationOptions } }) => {
  if (data.type === 'run' && data.options && !started) {
    started = true;
    const options = data.options;
    void import('./checks').then(({ runChecks }) => runChecks(options, (check) => send({ type: 'check', check })))
      .then((report) => {
        completed = true;
        send({ type: 'complete', report });
      })
      .catch((error: unknown) => {
        completed = true;
        send({ type: 'fatal', message: error instanceof Error ? error.stack ?? error.message : String(error) });
      });
  } else if (data.type === 'shutdown' && completed) {
    send({ type: 'stopped' });
    setImmediate(() => process.exit(0));
  }
});

send({ type: 'ready' });
