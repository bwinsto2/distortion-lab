/*
 * Hardware controller support (USB MIDI knobs and buttons) for the in-stereoscope menu.
 * Pure functions (no DOM, no Web MIDI calls) so they can be unit-tested; app.js wires them
 * to navigator.requestMIDIAccess().
 *
 * Endless knobs ("rotary encoders") are expected. Supported knob encodings, detected while
 * learning (turn right, then left):
 *   'signmag' : 1..63 = +n, 65..127 = -(v-64)     (Mackie Control V-Pots, e.g. X-Touch Mini in MC mode)
 *   'twos'    : 1..63 = +n, 65..127 = v-128        (two's complement, common "relative 1")
 *   'offset'  : 64+n / 64-n                         (binary offset, "relative 2")
 *   'abs'     : 0..127 absolute position (a knob with end stops) - works, but jumps can occur
 */
(function (root) {
  'use strict';

  var ACTIONS = [
    { id: 'value', kind: 'turn', label: 'Main knob: turn it RIGHT a few clicks, then LEFT a few clicks', required: true },
    { id: 'press', kind: 'press', label: 'Main knob PRESS (next control / choose)', required: true },
    { id: 'eye', kind: 'press', label: 'Button: Switch eye', required: true },
    { id: 'mode', kind: 'press', label: 'Button: Adjust / Compare', required: true },
    { id: 'alts', kind: 'press', label: 'Button: New alternatives', required: false },
    { id: 'undo', kind: 'press', label: 'Button: Undo', required: false },
    { id: 'select', kind: 'turn', label: 'Optional second knob: choose which control (turn right, then left)', required: false }
  ];

  /** Parse a raw MIDI message (array of bytes). */
  function parse(bytes) {
    var st = bytes[0] & 0xF0, ch = bytes[0] & 0x0F;
    if (st === 0xB0) return { type: 'cc', ch: ch, num: bytes[1], val: bytes[2] };
    if (st === 0x90) return { type: 'note', ch: ch, num: bytes[1], val: bytes[2] };     // note-on (val 0 = release)
    if (st === 0x80) return { type: 'note', ch: ch, num: bytes[1], val: 0 };            // note-off
    return { type: 'other' };
  }
  function sameControl(a, b) { return a.type === b.type && a.ch === b.ch && a.num === b.num; }

  /** Infer the binding for a knob from messages recorded while it was turned right then left. */
  function learnTurn(msgs) {
    var cc = msgs.filter(function (m) { return m.type === 'cc'; });
    if (cc.length < 3) return null;
    var first = cc[0];
    var same = cc.filter(function (m) { return sameControl(m, first); });
    if (same.length < 3) return null;
    var vals = same.map(function (m) { return m.val; });
    var enc;
    if (vals.every(function (v) { return v >= 54 && v <= 74 && v !== 64; })) enc = 'offset';
    else if (vals.every(function (v) { return (v >= 1 && v <= 20) || (v >= 65 && v <= 84) || (v >= 107 && v <= 127); }) &&
             vals.some(function (v) { return v <= 20; })) {
      // Relative: decide sign convention from the left turn values.
      var neg = vals.filter(function (v) { return v >= 65; });
      enc = neg.length && neg.filter(function (v) { return v >= 107; }).length > neg.length / 2 ? 'twos' : 'signmag';
    } else enc = 'abs';
    return { type: 'cc', ch: first.ch, num: first.num, enc: enc };
  }
  /** Binding for a button/press: the first press message (note-on or CC with value > 0). */
  function learnPress(m) {
    if ((m.type === 'note' || m.type === 'cc') && m.val > 0) return { type: m.type, ch: m.ch, num: m.num };
    return null;
  }

  /** Relative steps from a knob message. `memo` keeps the last absolute value per knob. */
  function knobSteps(binding, m, memo) {
    var v = m.val;
    if (binding.enc === 'signmag') return v === 0 || v === 64 ? 0 : (v < 64 ? v : -(v - 64));
    if (binding.enc === 'twos') return v === 0 || v === 64 ? 0 : (v < 64 ? v : v - 128);
    if (binding.enc === 'offset') return v - 64;
    var key = binding.ch + ':' + binding.num, last = memo[key];
    memo[key] = v;
    if (last === undefined) return 0;
    var d = v - last;
    if (d === 0) d = v === 127 ? 1 : (v === 0 ? -1 : 0);   // pushing against an end stop
    return Math.abs(d) > 40 ? 0 : d;
  }

  /** Decode one parsed message with a mapping {actionId: binding}. Returns [{action, steps}]. */
  function decode(mapping, m, memo) {
    var out = [];
    if (m.type === 'other') return out;
    Object.keys(mapping || {}).forEach(function (action) {
      var b = mapping[action];
      if (!b || !sameControl(b, m)) return;
      var def = ACTIONS.filter(function (a) { return a.id === action; })[0];
      if (!def) return;
      if (def.kind === 'turn') { var s = knobSteps(b, m, memo); if (s) out.push({ action: action, steps: s }); }
      else if (m.val > 0) out.push({ action: action, steps: 1 });
    });
    return out;
  }

  /** Keyboard fallback (also used for testing without hardware). */
  function keyAction(key, shift) {
    switch (key) {
      case 'ArrowRight': return { action: 'value', steps: shift ? 5 : 1 };
      case 'ArrowLeft': return { action: 'value', steps: shift ? -5 : -1 };
      case 'ArrowDown': return { action: 'select', steps: 1 };
      case 'ArrowUp': return { action: 'select', steps: -1 };
      case 'Enter': return { action: 'press', steps: 1 };
      case ' ': return { action: 'eye', steps: 1 };
      case 'm': case 'M': return { action: 'mode', steps: 1 };
      case 'n': case 'N': return { action: 'alts', steps: 1 };
      case 'z': case 'Z': case 'Backspace': return { action: 'undo', steps: 1 };
      default: return null;
    }
  }

  var api = { ACTIONS: ACTIONS, parse: parse, learnTurn: learnTurn, learnPress: learnPress, decode: decode, keyAction: keyAction, knobSteps: knobSteps };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.DLController = api;
})(typeof self !== 'undefined' ? self : this);
