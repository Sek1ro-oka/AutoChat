// Event fan-out for OneBot messages.
//
// Before V2 the transport handed every event straight to `Bot.ingest`. V2 needs
// more than one consumer (the answering bot, the social simulation engine, the
// message ledger), and a failure in one must never starve the others. This layer
// provides exactly that: an ordered list of participants, per-participant error
// isolation, and a drainable in-flight set so shutdown can wait for pending work.
//
// It deliberately does NOT own per-participant queues: each participant already
// serialises its own work (`Bot.tail`, `AntiSpam.tail`, …). Adding a second queue
// here would double-buffer and make the existing bounded-queue semantics opaque.

export class Runtime {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.participants = [];
    this.inflight = new Set();
  }
  // Register a participant. Order matters: participants run in registration order.
  use(name, handler) {
    if (typeof handler !== 'function') throw new TypeError('participant handler must be a function');
    const participant = { name, handler, failures: 0, lastError: null };
    this.participants.push(participant);
    return participant;
  }
  // Dispatch one event to every participant. Never rejects: a throwing or
  // rejecting participant is recorded and isolated, the rest still run.
  dispatch(event, send, alive) {
    const jobs = this.participants.map(participant => {
      let job;
      try { job = Promise.resolve(participant.handler(event, send, alive)); }
      catch (error) { job = Promise.reject(error); }
      return job.catch(error => {
        participant.failures += 1;
        participant.lastError = String(error?.message ?? error);
        this.log('participant_failed');
        return false;
      });
    });
    const all = Promise.all(jobs);
    this.inflight.add(all);
    const done = () => this.inflight.delete(all);
    all.then(done, done);
    return all;
  }
  // Wait until no dispatched event is still in flight (used by graceful stop).
  async drain() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }
  stats() {
    return this.participants.map(({ name, failures, lastError }) => ({ name, failures, lastError }));
  }
}
