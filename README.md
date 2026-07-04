# CRDT Collaborative Text Editor

A from-scratch sequence CRDT (conflict-free replicated data type) for
collaborative plain-text editing, in the Logoot/LSEQ family, plus a live
three-replica browser demo you can actually type in.

## What it does, and why it's useful

Google Docs-style collaborative editing has two broad solution families:
operational transformation (rewrite incoming operations against local history
so they still make sense) and CRDTs (design the data structure so operations
never conflict in the first place, no rewriting needed). This project
implements the second approach for plain text.

The core idea: every character gets a unique, densely-ordered position
identifier the instant it's typed, independent of any other replica. A
document is just a sorted list of `{identifier, character, deleted}` tuples.
"Merging" two replicas is nothing more than insert-sorting one's operations
into the other's list. That single property is what makes the whole thing
work without a central server or coordination:

- **Commutative** - it doesn't matter what order operations are applied in,
  the sorted result is the same either way.
- **Idempotent** - applying the same operation twice is harmless (checked by
  identifier before inserting).
- **No merge conflicts, ever** - two people typing at the "same position"
  simultaneously just get two different identifiers that happen to sort
  next to each other. There's nothing to resolve.

This is a genuinely useful building block, not just an algorithms exercise -
it's the same family of technique behind real collaborative editors (Google
Wave used Logoot-like schemes; Yjs and Automerge are the modern production
descendants for richer data). Understanding it from scratch is a good way to
understand why "just diff the strings" and "last write wins" both fall apart
for real-time multi-user editing.

## How to run it

Requires Node.js 18+.

```bash
npm install
npm test          # compiles with tsc, then runs the test suite
npm run demo       # compiles, then serves index.html at http://localhost:8080
```

Open `http://localhost:8080`, then type in any of the three "Site" text
boxes. Edits propagate to the other two after a randomized network delay
(configurable in the UI). Click **"Simulate network partition"**, edit
multiple boxes while disconnected, then click **"Heal partition"** - the
queued messages are flushed in a randomly shuffled order, and all three
replicas still converge to identical text.

There's no build step needed to read the algorithm itself: the whole CRDT is
`src/crdt.ts`, with no dependencies beyond the TypeScript standard library.

## How the identifier scheme works

Each identifier is a path of `(digit, site, counter)` levels, compared
lexicographically. To insert a character strictly between two existing
identifiers, `alloc()` walks both paths depth by depth looking for a gap of
at least 2 between the digits at that level:

- If there's room, pick a random digit in the gap - done.
- If there's no room (adjacent or equal digits), carry the lower bound's
  digit forward unchanged and try one level deeper. Since two distinct
  identifiers can't share every level forever, this always terminates.

Deletions are tombstones: the character is marked `deleted` but stays in the
list, because its identifier may still be a valid anchor point for a
concurrent insert that hasn't arrived yet.

## Design decisions and testing

**Why `(digit, site, counter)` and not just `(digit, site)`.** An earlier
version of `alloc()` only tagged each digit with the originating site, on the
assumption that two different sites could never produce the exact same
identifier. That's true across sites, but not *within* one: if a character is
typed and then deleted, its tombstone identifier is still sitting in the
list, and a later local insertion landing in that same gap has some
probability of independently picking that exact same digit again - producing
a genuine duplicate identifier from the *same* site. The fix was to fold a
monotonically increasing per-site counter into every level, so two
allocations from one site can never collide even if the random digit repeats.
`test/crdt.test.ts` has a dedicated regression test for this
(`identifiers stay unique even when a site reuses the same gap after a
delete`) that repeatedly inserts and deletes at the same position and asserts
every identifier the replica has ever stored is distinct.

**Why deletes need a pending buffer.** A delete operation names the
identifier it targets, but nothing guarantees the network delivers inserts
and deletes in the order they were generated. If a delete for identifier `X`
arrives before the insert that creates `X`, naively looking up `X` and
finding nothing would silently drop the delete - and the "deleted" character
would incorrectly reappear once its insert eventually showed up. Instead,
`remoteDelete` buffers the identifier in a pending set when it can't find the
target yet, and `remoteInsert` checks that set before adding a new node so
the delete is retroactively applied. `crdt.test.ts` covers this directly
("a delete delivered before its insert is still applied once the insert
arrives"), and the multi-replica fuzz test exercises it indirectly by
delivering hundreds of randomly interleaved insert/delete pairs in shuffled
order.

**Testing approach.** Rather than only asserting fixed examples, most of the
suite is property-based: generate random sequences of concurrent inserts and
deletes across two or three simulated replicas, deliver the resulting
operations in a randomly shuffled order (simulating an unreliable network),
and assert that every replica's final text is identical. This is what
actually caught the two bugs described above during development - a small
number of fixed-example unit tests would not have found either one, since
both require a specific, easy-to-miss interleaving to surface.

Run `npm test` to see all cases pass, including 100+160 randomized trials.

## Project structure

```
src/crdt.ts      the CRDT itself: identifiers, alloc(), RGADocument
src/network.ts   simulated unreliable network (random delay) used by the demo
src/demo.ts      wires three RGADocument instances to the demo's <textarea>s
test/crdt.test.ts  unit + property-based tests (Node's built-in test runner)
index.html       the demo page
serve.mjs        zero-dependency static file server for the demo
```

## Known limitations

- Identifiers grow with the number of same-position edits in a small region
  over the document's history (a known characteristic of naive Logoot,
  addressed in the literature by LSEQ's adaptive strategies - not
  implemented here for simplicity).
- The demo's `diffToOps` recovers edits from `<textarea>` snapshots via
  prefix/suffix diffing, which is a good match for real keystrokes but not a
  general-purpose text diff algorithm.
- This implements text only - no rich formatting, cursors, or presence.
