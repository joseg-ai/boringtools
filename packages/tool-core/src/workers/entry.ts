import { dispatchWorkerRequest } from './dispatch.js';

if (typeof document !== 'undefined') throw new Error('The tool worker entry must not run on the browser main thread.');

let started = false;
self.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (started) throw new Error('A tool worker accepts exactly one job.');
  started = true;
  void dispatchWorkerRequest(event.data, (response) => self.postMessage(response)).catch((error: unknown) => {
    // Surface unexpected faults through Worker.onerror, rather than disguising
    // programming errors as a success-shaped contract reply.
    setTimeout(() => { throw error; }, 0);
  });
});
