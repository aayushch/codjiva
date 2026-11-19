// Unit tests for the packets, the cursor and the frame. These parts are drawn
// as strings of SVG markup, so they can be tested in Node without a browser.
//
// The markup of every part is compared with a stored copy in
// `parts.snapshot.json`. A change to how a part looks therefore fails this
// test until the stored copy is updated on purpose:
//
//   UPDATE_SNAPSHOT=1 node --test unit/parts.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadRuntime } from '../load-runtime.mjs';

const { CJ, PACKET_FORMS, TAG_MAX } = loadRuntime(
  ['00-kit.js', '10-geom.js', '20-parts.js'],
  ['PACKET_FORMS', 'TAG_MAX'],
);

const SNAPSHOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'parts.snapshot.json',
);
// The kinds that can be combined with a form.
const KINDS = ['primary', 'secondary', 'transient'];

// The markup of every part, by a name that says what was drawn.
const drawAll = () => {
  const drawn = {};
  for (const form of PACKET_FORMS)
    for (const kind of KINDS) {
      drawn[`packet ${form} ${kind}`] = CJ.packet(kind, 'p', { form });
      drawn[`packet ${form} ${kind} tag`] = CJ.packet(kind, 'p', {
        form,
        tag: 'ab1',
      });
    }
  drawn['packet batch'] = CJ.packet('batch', 'p');
  drawn['packet tally'] = CJ.packet('tally', 'p');
  for (const dir of ['d', 'u', 'l', 'r'])
    drawn[`cursor ${dir}`] = CJ.cursor('p', dir);
  drawn['frame'] = CJ.frame('p', 100, 200, 300, 150);
  // The parts of a state machine. The ones with words have markup for the
  // drawing and markup for the words, and both are compared.
  const both = (part) => part.svg + '\n' + part.html;
  drawn['state'] = both(CJ.state('p', 100, 200, 220, 70, 'Allowing'));
  drawn['state start sub'] = both(
    CJ.state('p', 100, 200, 220, 70, 'Start', { kind: 'start', sub: 'p = 0' }),
  );
  drawn['state accept'] = both(
    CJ.state('p', 100, 200, 220, 70, 'Done', { kind: 'accept' }),
  );
  drawn['edge'] = both(CJ.edge('p', 'M320 235 H500', { label: 'an order' }));
  drawn['edge fallback down'] = both(
    CJ.edge('p', 'M210 270 V400', { label: 'on error', kind: 'fallback' }),
  );
  drawn['edge loop'] = both(CJ.edge('p', 'M150 200 V160 H270 V200'));
  drawn['edge quiet'] = both(CJ.edge('p', 'M320 235 H500', { kind: 'quiet' }));
  drawn['tape'] = both(CJ.tape('p', 100, 200, 4));
  drawn['registers'] = both(CJ.registers('p', 100, 200, 300, ['p', 'count']));
  return drawn;
};

test('every part is drawn exactly as its stored copy', () => {
  const drawn = drawAll();
  if (process.env.UPDATE_SNAPSHOT || !existsSync(SNAPSHOT)) {
    writeFileSync(SNAPSHOT, JSON.stringify(drawn, null, 2) + '\n');
    return;
  }
  const stored = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  assert.deepEqual(Object.keys(drawn), Object.keys(stored));
  for (const name of Object.keys(drawn))
    assert.equal(drawn[name], stored[name], `${name} has changed`);
});

test('a packet without a form or a tag is a crate with no data-form', () => {
  for (const kind of [...KINDS, 'batch', 'tally']) {
    assert.equal(CJ.packet(kind, 'p'), CJ.packet(kind, 'p', {}));
    assert.equal(CJ.packet(kind, 'p'), CJ.packet(kind, 'p', { form: 'crate' }));
    assert.ok(!CJ.packet(kind, 'p').includes('data-form'));
  }
});

test('a packet with a form names its form and kind in its markup', () => {
  const markup = CJ.packet('secondary', 'p', { form: 'element' });
  assert.ok(markup.startsWith('<g class="p" data-cj="packet"'));
  assert.ok(markup.includes('data-kind="secondary"'));
  assert.ok(markup.includes('data-form="element"'));
});

test('a tag is written on the packet, with its special characters escaped', () => {
  const markup = CJ.packet('primary', 'p', { form: 'value', tag: '<3' });
  assert.match(markup, /<text class="cj-tag"[^>]*>&lt;3<\/text>/);
});

test('an empty tag still gives the packet a place for a tag', () => {
  assert.match(
    CJ.packet('primary', 'p', { form: 'value', tag: '' }),
    /<text class="cj-tag"[^>]*><\/text>/,
  );
  assert.ok(!CJ.packet('primary', 'p', { form: 'value' }).includes('cj-tag'));
});

test('a tag longer than the limit is refused', () => {
  const long = 'x'.repeat(TAG_MAX + 1);
  assert.throws(() => CJ.packet('primary', 'p', { tag: long }), /at most 3/);
  assert.doesNotThrow(() =>
    CJ.packet('primary', 'p', { tag: 'x'.repeat(TAG_MAX) }),
  );
});

test('an unknown form is refused with the list of forms', () => {
  assert.throws(
    () => CJ.packet('primary', 'p', { form: 'pill' }),
    /no packet form called "pill".*crate, record, value, key, element, chunk/,
  );
});

test('the head of a transition points the way its last segment runs', () => {
  const turnOf = (d) => /rotate\((\d+)\)/.exec(CJ.edge('p', d).svg)?.[1];
  assert.equal(turnOf('M0 0 H100'), '0');
  assert.equal(turnOf('M0 0 V100'), '90');
  assert.equal(turnOf('M100 0 H0'), '180');
  assert.equal(turnOf('M0 100 V0'), '270');
  // A loop ends going down into the state it left.
  assert.equal(turnOf('M150 200 V160 H270 V200'), '90');
});

test('the label of a transition sits at the middle of its longest segment', () => {
  // Above a horizontal segment: 14 px text, 3 characters, is 25.2 px wide.
  assert.match(
    CJ.edge('p', 'M100 300 H300', { label: 'abc' }).html,
    /left:187px;top:276px/,
  );
  // To the right of a vertical segment.
  assert.match(
    CJ.edge('p', 'M100 300 V500', { label: 'abc' }).html,
    /left:110px;top:392px/,
  );
  // Where the plant says, when it says.
  assert.match(
    CJ.edge('p', 'M100 300 H300', { label: 'abc', at: [40, 50] }).html,
    /left:40px;top:50px/,
  );
  assert.equal(CJ.edge('p', 'M100 300 H300').html, '');
});

test('the kinds batch and tally take no form and no tag', () => {
  for (const kind of ['batch', 'tally']) {
    assert.throws(
      () => CJ.packet(kind, 'p', { form: 'record' }),
      /has its own shape/,
    );
    assert.throws(
      () => CJ.packet(kind, 'p', { tag: '1' }),
      /has its own shape/,
    );
  }
});
