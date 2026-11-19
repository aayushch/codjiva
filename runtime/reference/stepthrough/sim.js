// Limiter.Allow, restated one order at a time for one customer. Every branch below is a branch
// of internal/orders/limiter.go, and its `ref` names that line.
//
// The input is read one character at a time. '>' means that one minute passes. Every other
// character is one order of the customer.

const FILE = 'internal/orders/limiter.go';
const RATE_WINDOW = 60;   // rateWindow, in seconds (limiter.go:8)
const SOFT = 30;          // softOrdersPerWindow (limiter.go:11)
const HARD = 60;          // hardOrdersPerWindow (limiter.go:14)

// The state of the drawing that a window is in.
const stateOf = (w) => (!w ? 'none' : w.blocked ? 'blocked' : w.count > SOFT ? 'defer' : 'allow');

CJ.defineSim({
  init() {
    // p: the next character. now: seconds since the start. w: the customer's window, or null.
    // pending: true when the window was just replaced and the same order still has to be counted.
    return { p: 0, now: 0, w: null, pending: false, verdict: '', tally: { allow: 0, defer: 0, blocked: 0 }, changed: [0, 0, 0, 0] };
  },

  step(m, input) {
    m.changed = [0, 0, 0, 0];
    if (m.p >= input.length) return null;
    const at = m.p;
    const before = stateOf(m.w);

    if (input[at] === '>') {
      m.p++;
      m.now += RATE_WINDOW;
      m.changed[0] = 1;
      return { state: before, at, does: ['now += 1 minute'], note: 'One minute passes. Nothing in the Limiter runs until the next order arrives.' };
    }

    // An order arrives: Allow(customerID, now).
    if (m.w && !m.pending && m.now - m.w.start >= RATE_WINDOW) {
      // limiter.go:55, second half of the condition. The order is counted in the next step.
      m.w = null;
      m.pending = true;
      m.changed = [0, 1, 1, 1];
      return {
        state: 'none', edge: 'x' + before, at,
        does: ['now.Sub(w.start) >= rateWindow', 'the old window is dropped'],
        note: 'The window began a minute ago or more, so this order starts a new one.',
        tone: 'ok', ref: FILE + ':55',
      };
    }
    m.p++;
    m.pending = false;

    if (!m.w) {
      // limiter.go:56, then 62 and 70: a new window, and its first order is always allowed.
      m.w = { start: m.now, count: 1, blocked: false };
      m.verdict = 'VerdictAllow';
      m.tally.allow++;
      m.changed = [0, 1, 1, 1];
      return {
        state: 'allow', edge: 'first', at,
        does: ['w = &customerWindow{start: now}', 'w.count++ → 1', 'return VerdictAllow'],
        note: 'A new window starts with this order, which is allowed.',
        tone: 'ok', ref: FILE + ':56',
      };
    }

    if (m.w.blocked) {
      // limiter.go:59. The order is not counted.
      m.verdict = 'VerdictBlocked';
      m.tally.blocked++;
      return {
        state: 'blocked', edge: 'blockedstay', at,
        does: ['w.blocked is true', 'return VerdictBlocked'],
        note: 'The customer is blocked, so the order is dropped without being counted.',
        tone: 'warn', ref: FILE + ':59',
      };
    }

    m.w.count++;
    m.changed[2] = 1;
    if (m.w.count > HARD) {
      // limiter.go:64.
      m.w.blocked = true;
      m.changed[3] = 1;
      m.verdict = 'VerdictBlocked';
      m.tally.blocked++;
      return {
        state: 'blocked', edge: 'hard', at,
        does: ['w.count++ → ' + m.w.count, 'w.count > hardOrdersPerWindow', 'w.blocked = true', 'return VerdictBlocked'],
        note: 'Order ' + m.w.count + ' of this window is over the hard limit. It is dropped and the customer is blocked.',
        tone: 'warn', ref: FILE + ':64',
      };
    }
    if (m.w.count > SOFT) {
      // limiter.go:67.
      m.verdict = 'VerdictDefer';
      m.tally.defer++;
      return {
        state: 'defer', edge: before === 'allow' ? 'soft' : 'deferstay', at,
        does: ['w.count++ → ' + m.w.count, 'w.count > softOrdersPerWindow', 'return VerdictDefer'],
        note: 'Order ' + m.w.count + ' of this window is over the soft limit. It is accepted, and waits for the next tick.',
        tone: before === 'allow' ? 'warn' : '', ref: FILE + ':67',
      };
    }
    // limiter.go:70.
    m.verdict = 'VerdictAllow';
    m.tally.allow++;
    return {
      state: 'allow', edge: 'allowstay', at,
      does: ['w.count++ → ' + m.w.count, 'return VerdictAllow'],
      note: 'Order ' + m.w.count + ' of this window is processed now.',
      ref: FILE + ':70',
    };
  },

  vars(m) {
    return {
      now: m.now + ' s',
      'w.start': m.w ? m.w.start + ' s' : 'no window',
      'w.count': m.w ? m.w.count : 0,
      'w.blocked': m.w ? m.w.blocked : false,
    };
  },

  outputs(m) {
    return {
      verdict: m.verdict,
      allowed: m.tally.allow,
      deferred: m.tally.defer,
      blocked: m.tally.blocked,
    };
  },

  stage(m) {
    return {
      reg: [m.now + ' s', m.w ? m.w.start + ' s' : '', m.w ? String(m.w.count) : '0', m.w ? String(m.w.blocked) : 'false'],
      changed: m.changed,
    };
  },
});
