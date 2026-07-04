/**
 * Wires three RGADocument replicas up to three <textarea> elements and a
 * simulated unreliable network, so you can watch the CRDT converge live.
 *
 * Each textarea's `input` event gives us only the new full string, not a
 * structured edit, so `diffToOps` recovers a (delete, insert) pair by
 * finding the common prefix/suffix between the old and new value. That's
 * good enough for interactive typing, where each keystroke changes a small,
 * contiguous span of text.
 */
import { RGADocument, Op } from './crdt.js';
import { SimulatedNetwork } from './network.js';

interface ClientUI {
  siteId: number;
  doc: RGADocument;
  textarea: HTMLTextAreaElement;
  lastText: string;
}

function diffToOps(doc: RGADocument, oldText: string, newText: string): Op[] {
  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix++;

  let suffix = 0;
  const maxSuffix = Math.min(oldText.length, newText.length) - prefix;
  while (
    suffix < maxSuffix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix++;
  }

  const ops: Op[] = [];
  const removedLen = oldText.length - prefix - suffix;
  const insertedText = newText.slice(prefix, newText.length - suffix);

  // Deletes first, working from the end backwards so indices stay valid.
  for (let i = 0; i < removedLen; i++) {
    ops.push(doc.localDelete(prefix));
  }
  for (let i = 0; i < insertedText.length; i++) {
    ops.push(doc.localInsert(prefix + i, insertedText[i]));
  }
  return ops;
}

function log(el: HTMLElement, text: string): void {
  const line = document.createElement('div');
  line.textContent = text;
  el.prepend(line);
  while (el.childNodes.length > 200) el.removeChild(el.lastChild as ChildNode);
}

export function initDemo(): void {
  const logEl = document.getElementById('log') as HTMLElement;
  const minDelayInput = document.getElementById('minDelay') as HTMLInputElement;
  const maxDelayInput = document.getElementById('maxDelay') as HTMLInputElement;
  const partitionBtn = document.getElementById('partitionBtn') as HTMLButtonElement;
  const resetBtn = document.getElementById('resetBtn') as HTMLButtonElement;

  let partitioned = false;
  const queuedMessages: { op: Op; from: number; to: number }[] = [];

  const clients: ClientUI[] = [1, 2, 3].map((siteId) => ({
    siteId,
    doc: new RGADocument(siteId),
    textarea: document.getElementById(`editor${siteId}`) as HTMLTextAreaElement,
    lastText: '',
  }));

  const network = new SimulatedNetwork<Op>(
    { minDelayMs: 100, maxDelayMs: 1500 },
    (op, fromSite, toSite) => {
      const target = clients.find((c) => c.siteId === toSite)!;
      if (op.type === 'insert') target.doc.remoteInsert(op);
      else target.doc.remoteDelete(op);
      target.lastText = target.doc.getText();
      target.textarea.value = target.lastText;
      log(logEl, `deliver ${op.type} site${fromSite} -> site${toSite}`);
    }
  );

  function currentDelayOptions() {
    return {
      minDelayMs: Number(minDelayInput.value),
      maxDelayMs: Number(maxDelayInput.value),
    };
  }

  function broadcast(from: ClientUI, op: Op): void {
    for (const other of clients) {
      if (other.siteId === from.siteId) continue;
      if (partitioned) {
        queuedMessages.push({ op, from: from.siteId, to: other.siteId });
        log(logEl, `queued (partitioned) ${op.type} site${from.siteId} -> site${other.siteId}`);
      } else {
        Object.assign(network as any, { options: currentDelayOptions() });
        network.send(op, from.siteId, other.siteId);
        log(logEl, `sent ${op.type} site${from.siteId} -> site${other.siteId}`);
      }
    }
  }

  for (const client of clients) {
    client.textarea.addEventListener('input', () => {
      const newText = client.textarea.value;
      const ops = diffToOps(client.doc, client.lastText, newText);
      client.lastText = client.doc.getText();
      for (const op of ops) broadcast(client, op);
    });
  }

  partitionBtn.addEventListener('click', () => {
    partitioned = !partitioned;
    partitionBtn.textContent = partitioned
      ? 'Heal partition (flush queued edits)'
      : 'Simulate network partition';
    log(logEl, partitioned ? '--- network partitioned ---' : '--- partition healed, flushing queue ---');

    if (!partitioned) {
      // shuffle the queue to prove delivery order doesn't matter
      for (let i = queuedMessages.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queuedMessages[i], queuedMessages[j]] = [queuedMessages[j], queuedMessages[i]];
      }
      const toFlush = queuedMessages.splice(0, queuedMessages.length);
      for (const msg of toFlush) {
        network.send(msg.op, msg.from, msg.to);
      }
    }
  });

  resetBtn.addEventListener('click', () => window.location.reload());
}

initDemo();
