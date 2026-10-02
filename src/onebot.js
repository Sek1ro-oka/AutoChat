import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

export class OneBot {
  constructor(config, { onEvent = () => {}, log = () => {} } = {}) {
    this.config = config; this.onEvent = onEvent; this.log = log;
    this.pending = new Map(); this.stopped = true; this.generation = 0;
    this.retry = 0; this.ready = false;
  }
  start() { this.stopped = false; this.connect(); }
  connect() {
    if (this.stopped) return;
    this.generation++;
    const generation = this.generation;
    const socket = new WebSocket(this.config.wsUrl, {
      headers: { Authorization: `Bearer ${this.config.onebotToken}` },
      handshakeTimeout: 10000, maxPayload: 1024 * 1024,
    });
    this.socket = socket; this.ready = false;
    let receivedPong = true;
    socket.on('pong', () => { receivedPong = true; });
    const heartbeat = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (!receivedPong) { socket.terminate(); return; }
      receivedPong = false; socket.ping();
    }, 30000);
    socket.on('open', async () => {
      try {
        const login = await this.call('get_login_info', {}, generation);
        if (String(login.user_id) !== this.config.botId) {
          this.log('account_mismatch'); this.stop(); return;
        }
        this.ready = true; this.retry = 0; this.log('onebot_connected');
      } catch { socket.close(); }
    });
    socket.on('message', raw => {
      let body;
      try { body = JSON.parse(raw.toString()); } catch { this.log('invalid_onebot_json'); return; }
      if (!body || typeof body !== 'object') return;
      if (typeof body.echo === 'string' && this.pending.has(body.echo)) {
        const pending = this.pending.get(body.echo);
        this.pending.delete(body.echo); clearTimeout(pending.timer);
        if (body.status === 'ok' && body.retcode === 0) pending.resolve(body.data ?? {});
        else pending.reject(new Error('ONEBOT_ACTION_FAILED'));
      } else if (this.ready && generation === this.generation && body.post_type) {
        const alive = () => this.ready && generation === this.generation && socket.readyState === WebSocket.OPEN;
        try {
          Promise.resolve(this.onEvent(body, (action, params) => this.call(action, params, generation), alive))
            .catch(() => this.log('event_failed'));
        } catch { this.log('event_failed'); }
      }
    });
    socket.on('error', () => this.log('onebot_connection_error'));
    socket.on('close', () => {
      clearInterval(heartbeat);
      this.ready = false;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer); pending.reject(new Error('ONEBOT_DISCONNECTED'));
      }
      this.pending.clear();
      if (!this.stopped) {
        const delay = Math.min(30000, 1000 * 2 ** Math.min(this.retry++, 5));
        this.log('onebot_disconnected');
        this.timer = setTimeout(() => this.connect(), delay);
      }
    });
  }
  call(action, params, generation = this.generation) {
    if (generation !== this.generation || this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('ONEBOT_NOT_CONNECTED'));
    }
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo); reject(new Error('ONEBOT_TIMEOUT'));
      }, this.config.actionTimeoutMs ?? 10000);
      this.pending.set(echo, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ action, params, echo }), error => {
        if (!error) return;
        const pending = this.pending.get(echo);
        if (pending) { clearTimeout(timer); this.pending.delete(echo); reject(new Error('ONEBOT_SEND_FAILED')); }
      });
    });
  }
  stop() {
    this.stopped = true; this.ready = false; clearTimeout(this.timer);
    this.socket?.terminate();
  }
}
