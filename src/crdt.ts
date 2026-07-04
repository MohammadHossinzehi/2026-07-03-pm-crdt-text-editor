/**
 * A sequence CRDT for collaborative plain-text editing, in the Logoot/LSEQ family.
 *
 * Instead of coordinating through a server or resolving edits with operational
 * transforms, every character gets a globally unique, densely-ordered
 * identifier the moment it's typed. Documents converge because "merge" is
 * just "insert-sort by identifier" - it doesn't matter what order replicas
 * receive operations in, or whether messages are duplicated, as long as every
 * operation eventually arrives once.
 *
 * See the README for the full explanation of the identifier scheme and the
 * causal-delivery subtlety around deletes.
 */

/** One level of a position identifier: a digit, the site that minted it, and
 * that site's logical clock value at the time. The (site, counter) pair
 * exists purely to break ties - two sites can legitimately pick the same
 * digit in the same gap, and a single site can even pick a digit that
 * matches one it used earlier for a since-deleted character. Digit alone is
 * not enough to guarantee uniqueness; (digit, site, counter) is. */
export interface IdLevel {
  digit: number;
  site: number;
  counter: number;
}

/** A position identifier is a path of levels; longer paths let you insert
 * arbitrarily densely between two existing identifiers. */
export type Id = IdLevel[];

export interface CharNode {
  id: Id;
  value: string;
  deleted: boolean;
}

export type Op =
  | { type: 'insert'; node: CharNode }
  | { type: 'delete'; id: Id };

const BASE = 32768;
const MAX_DEPTH = 200;

/** Total order over identifiers: compare level by level, treating a missing
 * level as smaller than any real one (so a prefix sorts before anything that
 * extends it). */
export function compareId(a: Id, b: Id): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const da = i < a.length ? a[i].digit : -1;
    const db = i < b.length ? b[i].digit : -1;
    if (da !== db) return da - db;
    const sa = i < a.length ? a[i].site : -1;
    const sb = i < b.length ? b[i].site : -1;
    if (sa !== sb) return sa - sb;
    const ca = i < a.length ? a[i].counter : -1;
    const cb = i < b.length ? b[i].counter : -1;
    if (ca !== cb) return ca - cb;
  }
  return 0;
}

export function idToString(id: Id): string {
  return id.map((l) => `${l.digit}.${l.site}.${l.counter}`).join('/');
}

/**
 * Allocate a fresh identifier strictly between id1 and id2 (either can be
 * `[]`, meaning "no bound" / -infinity or +infinity respectively).
 *
 * At each depth we look at the digit gap between the two bounds. A gap of at
 * least 2 means there's room to drop a brand new random digit right there.
 * Otherwise there's no room at this depth, so we carry the lower bound's
 * digit forward unchanged and try again one level deeper - eventually the
 * paths diverge (one bound runs out first) and a gap opens up.
 */
function alloc(id1: Id, id2: Id, siteId: number, counter: number): Id {
  const result: Id = [];
  let i = 0;
  while (i < MAX_DEPTH) {
    const d1 = i < id1.length ? id1[i].digit : 0;
    const s1 = i < id1.length ? id1[i].site : siteId;
    const c1 = i < id1.length ? id1[i].counter : counter;
    const d2 = i < id2.length ? id2[i].digit : BASE;

    if (d2 - d1 >= 2) {
      const digit = d1 + 1 + Math.floor(Math.random() * (d2 - d1 - 1));
      result.push({ digit, site: siteId, counter });
      return result;
    }

    result.push({
      digit: d1,
      site: i < id1.length ? s1 : siteId,
      counter: i < id1.length ? c1 : counter,
    });
    i++;
  }
  throw new Error(`CRDT identifier allocation exceeded max depth (${MAX_DEPTH})`);
}

/**
 * A single replica's view of a collaboratively-edited text document.
 *
 * `nodes` is always kept sorted by identifier and includes tombstones
 * (deleted characters are marked, not removed) so that identifiers already
 * handed out remain valid anchors for future concurrent inserts.
 */
export class RGADocument {
  readonly siteId: number;
  private counter = 0;
  private nodes: CharNode[] = [];

  // Deletes that reference an id we haven't seen an insert for yet. This
  // happens when a delete op is delivered before the insert op it targets,
  // which is entirely possible when the network reorders messages. We can't
  // just drop it - a lost delete would let a supposedly-deleted character
  // reappear - so we buffer it and apply it retroactively once the insert
  // arrives. See remoteInsert / remoteDelete.
  private pendingDeletes = new Set<string>();

  constructor(siteId: number) {
    this.siteId = siteId;
  }

  private findInsertPos(id: Id): number {
    let lo = 0;
    let hi = this.nodes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareId(this.nodes[mid].id, id) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Maps a position in the *visible* (non-tombstoned) text to an index into
   * the full `nodes` array, or -1 if out of range. */
  private visibleIndexToRealIndex(visibleIndex: number): number {
    let count = 0;
    for (let i = 0; i < this.nodes.length; i++) {
      if (!this.nodes[i].deleted) {
        if (count === visibleIndex) return i;
        count++;
      }
    }
    return -1;
  }

  /** Insert `value` (a single character, or a short string) so it lands at
   * visible position `visibleIndex`. Returns the op to broadcast to peers. */
  localInsert(visibleIndex: number, value: string): Op {
    const beforeReal = visibleIndex === 0 ? -1 : this.visibleIndexToRealIndex(visibleIndex - 1);
    const afterReal = this.visibleIndexToRealIndex(visibleIndex);
    const idBefore: Id = beforeReal === -1 ? [] : this.nodes[beforeReal].id;
    const idAfter: Id = afterReal === -1 ? [] : this.nodes[afterReal].id;

    this.counter++;
    const id = alloc(idBefore, idAfter, this.siteId, this.counter);
    const node: CharNode = { id, value, deleted: false };
    this.nodes.splice(this.findInsertPos(id), 0, node);
    return { type: 'insert', node: { id, value, deleted: false } };
  }

  /** Apply a remote insert op. Idempotent: applying the same op twice is a
   * no-op the second time. */
  remoteInsert(op: Extract<Op, { type: 'insert' }>): void {
    const pos = this.findInsertPos(op.node.id);
    if (pos < this.nodes.length && compareId(this.nodes[pos].id, op.node.id) === 0) {
      return; // already have this character (duplicate delivery)
    }
    const key = idToString(op.node.id);
    const deleted = op.node.deleted || this.pendingDeletes.has(key);
    this.pendingDeletes.delete(key);
    this.nodes.splice(pos, 0, { id: op.node.id, value: op.node.value, deleted });
  }

  /** Delete the character at visible position `visibleIndex`. Returns the op
   * to broadcast to peers. */
  localDelete(visibleIndex: number): Op {
    const real = this.visibleIndexToRealIndex(visibleIndex);
    if (real === -1) throw new RangeError(`index ${visibleIndex} out of range`);
    this.nodes[real].deleted = true;
    return { type: 'delete', id: this.nodes[real].id };
  }

  /** Apply a remote delete op. Idempotent, and safe to receive before the
   * corresponding insert (see pendingDeletes above). */
  remoteDelete(op: Extract<Op, { type: 'delete' }>): void {
    const pos = this.findInsertPos(op.id);
    if (pos < this.nodes.length && compareId(this.nodes[pos].id, op.id) === 0) {
      this.nodes[pos].deleted = true;
    } else {
      this.pendingDeletes.add(idToString(op.id));
    }
  }

  getText(): string {
    return this.nodes
      .filter((n) => !n.deleted)
      .map((n) => n.value)
      .join('');
  }

  get length(): number {
    let c = 0;
    for (const n of this.nodes) if (!n.deleted) c++;
    return c;
  }

  /** Exposed for tests: every identifier this replica has ever stored
   * (including tombstones), as strings. Used to assert the uniqueness
   * invariant that identifier allocation depends on. */
  debugAllIds(): string[] {
    return this.nodes.map((n) => idToString(n.id));
  }
}
