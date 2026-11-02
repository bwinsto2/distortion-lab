// MIDI decoding / learning tests:  node --test tests/controller.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../web/js/controller.js');

const cc = (num, val, ch = 0) => K.parse([0xB0 | ch, num, val]);
const note = (num, vel, ch = 0) => K.parse([0x90 | ch, num, vel]);

test('parse note-on, note-off and CC', () => {
  assert.deepEqual(cc(16, 1), { type: 'cc', ch: 0, num: 16, val: 1 });
  assert.deepEqual(note(32, 127, 2), { type: 'note', ch: 2, num: 32, val: 127 });
  assert.deepEqual(K.parse([0x80, 32, 64]), { type: 'note', ch: 0, num: 32, val: 0 });
  assert.equal(K.parse([0xF8]).type, 'other');
});

test('learn knob encodings from a right-then-left turn', () => {
  // Mackie V-Pot sign-magnitude (X-Touch Mini MC mode): right 1,1,2 ; left 65,65,66
  assert.equal(K.learnTurn([16, 16, 16, 16, 16, 16].map((n, i) => cc(n, [1, 1, 2, 65, 65, 66][i]))).enc, 'signmag');
  // two's complement: left 127,127,126
  assert.equal(K.learnTurn([1, 1, 2, 127, 127, 126].map((v) => cc(20, v))).enc, 'twos');
  // binary offset around 64
  assert.equal(K.learnTurn([65, 65, 66, 63, 63, 62].map((v) => cc(21, v))).enc, 'offset');
  // absolute knob with end stops
  assert.equal(K.learnTurn([40, 41, 43, 45, 44, 42, 40].map((v) => cc(22, v))).enc, 'abs');
  assert.equal(K.learnTurn([cc(1, 1)]), null, 'too few messages');
});

test('decode actions with a mapping; releases ignored; other controls ignored', () => {
  const map = { value: { type: 'cc', ch: 0, num: 16, enc: 'signmag' }, press: { type: 'note', ch: 0, num: 32 },
    eye: { type: 'note', ch: 0, num: 89 }, select: { type: 'cc', ch: 0, num: 17, enc: 'twos' } };
  const memo = {};
  assert.deepEqual(K.decode(map, cc(16, 3), memo), [{ action: 'value', steps: 3 }]);
  assert.deepEqual(K.decode(map, cc(16, 66), memo), [{ action: 'value', steps: -2 }]);
  assert.deepEqual(K.decode(map, cc(17, 127), memo), [{ action: 'select', steps: -1 }]);
  assert.deepEqual(K.decode(map, note(32, 127), memo), [{ action: 'press', steps: 1 }]);
  assert.deepEqual(K.decode(map, note(32, 0), memo), []);
  assert.deepEqual(K.decode(map, note(89, 100), memo), [{ action: 'eye', steps: 1 }]);
  assert.deepEqual(K.decode(map, note(90, 100), memo), []);
  assert.deepEqual(K.decode(map, cc(16, 3, 1), memo), [], 'different channel');
});

test('absolute knobs give relative steps', () => {
  const b = { type: 'cc', ch: 0, num: 7, enc: 'abs' }, memo = {};
  assert.equal(K.knobSteps(b, cc(7, 50), memo), 0);
  assert.equal(K.knobSteps(b, cc(7, 53), memo), 3);
  assert.equal(K.knobSteps(b, cc(7, 51), memo), -2);
  assert.equal(K.knobSteps(b, cc(7, 127), memo), 0, 'large jump ignored');
  assert.equal(K.knobSteps(b, cc(7, 127), memo), 1, 'pushing against the end stop');
});

test('keyboard fallback mapping', () => {
  assert.deepEqual(K.keyAction('ArrowRight', true), { action: 'value', steps: 5 });
  assert.deepEqual(K.keyAction(' ', false), { action: 'eye', steps: 1 });
  assert.equal(K.keyAction('q', false), null);
});
