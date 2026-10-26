import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as keymap from '../src/keymap.js';
import './helpers.js';

test('normalizes Key Map codes and rejects unused letters', () => {
    assert.equal(keymap.normalizeCode(' 494g '), '494G');
    assert.equal(keymap.normalizeCode('1234Z'), '1234Z');
    assert.equal(keymap.normalizeCode('494I'), null);
    assert.equal(keymap.normalizeCode('494O'), null);
    assert.equal(keymap.normalizeCode(''), null);
    assert.equal(keymap.normalizeCode('KATY'), null);
});

test('ring centroid, with bounds check', () => {
    const sq = { rings: [[[-95.40, 29.70], [-95.38, 29.70], [-95.38, 29.72], [-95.40, 29.72], [-95.40, 29.70]]] };
    const c = keymap.ringCentroid(sq);
    assert.ok(Math.abs(c.lat - 29.71) < 1e-9 && Math.abs(c.lon + 95.39) < 1e-9);
    assert.equal(keymap.ringCentroid({ rings: [[[0, 0], [1, 0], [1, 1]]] }), null); // outside Houston area
    assert.equal(keymap.ringCentroid(null), null);
});
