import test from 'node:test';
import assert from 'node:assert/strict';
import { RGADocument, Op } from '../src/crdt.js';

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

test('typing sequentially on a single replica produces the typed text', () => {
  const doc = new RGADocument(1);
  const word = 'hello world';
  for (let i = 0; i < word.length; i++) doc.localInsert(i, word[i]);
  assert.equal(doc.getText(), word);
});

test('deleting a character removes it from the visible text', () => {
  const doc = new RGADocument(1);
  'abc'.split('').forEach((c, i) => doc.localInsert(i, c));
  doc.localDelete(1); // remove 'b'
  assert.equal(doc.getText(), 'ac');
});

test('two replicas typing concurrently converge regardless of delivery order', () => {
  for (let trial = 0; trial < 100; trial++) {
    const a = new RGADocument(1);
    const b = new RGADocument(2);
    const opsFromA: Op[] = [];
    const opsFromB: Op[] = [];

    'CAT'.split('').forEach((c, i) => opsFromA.push(a.localInsert(i, c)));
    'dog'.split('').forEach((c, i) => opsFromB.push(b.localInsert(i, c)));

    for (const op of shuffle(opsFromB)) a.remoteInsert(op as Extract<Op, { type: 'insert' }>);
    for (const op of shuffle(opsFromA)) b.remoteInsert(op as Extract<Op, { type: 'insert' }>);

    assert.equal(a.getText(), b.getText());
  }
});

test('a delete delivered before its insert is still applied once the insert arrives', () => {
  const a = new RGADocument(1);
  const b = new RGADocument(2);

  const insertOp = a.localInsert(0, 'x') as Extract<Op, { type: 'insert' }>;
  const deleteOp = a.localDelete(0) as Extract<Op, { type: 'delete' }>;

  // simulate the network delivering the delete first
  b.remoteDelete(deleteOp);
  assert.equal(b.getText(), ''); // nothing to delete yet, buffered
  b.remoteInsert(insertOp);
  assert.equal(b.getText(), ''); // insert arrives already-deleted, per pending buffer
});

test('three replicas converge under random concurrent inserts, deletes, and out-of-order delivery', () => {
  const chars = 'abcdefg';

  for (let trial = 0; trial < 60; trial++) {
    const sites = [new RGADocument(1), new RGADocument(2), new RGADocument(3)];
    const log: { origin: RGADocument; op: Op }[] = [];

    for (let step = 0; step < 60; step++) {
      const s = sites[Math.floor(Math.random() * sites.length)];
      const visibleLen = s.length;
      if (visibleLen === 0 || Math.random() < 0.7) {
        const idx = Math.floor(Math.random() * (visibleLen + 1));
        const ch = chars[Math.floor(Math.random() * chars.length)];
        log.push({ origin: s, op: s.localInsert(idx, ch) });
      } else {
        const idx = Math.floor(Math.random() * visibleLen);
        log.push({ origin: s, op: s.localDelete(idx) });
      }
    }

    for (const entry of shuffle(log)) {
      for (const s of sites) {
        if (s === entry.origin) continue;
        if (entry.op.type === 'insert') s.remoteInsert(entry.op);
        else s.remoteDelete(entry.op);
      }
    }

    const texts = sites.map((s) => s.getText());
    assert.equal(texts[0], texts[1], `trial ${trial}: site1 vs site2 diverged`);
    assert.equal(texts[1], texts[2], `trial ${trial}: site2 vs site3 diverged`);
  }
});

test('regression: identifiers stay unique even when a site reuses the same gap after a delete', () => {
  // This is the scenario that broke an earlier version of alloc(): a
  // character is inserted and then deleted, and a later insert lands in
  // the same identifier gap. Digit alone can collide by chance; the
  // (site, counter) tie-break must keep every identifier distinct.
  const doc = new RGADocument(1);
  for (let i = 0; i < 300; i++) {
    doc.localInsert(0, 'x');
    doc.localDelete(0);
  }
  const ids = doc.debugAllIds();
  assert.equal(new Set(ids).size, ids.length, 'duplicate identifier detected');
});
