import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePresentedMessage } from './messagePresentation.js';

const first = { id: 'physical-first', subject: 'First physical subject', from_email: 'first@example.invalid' };
const second = { id: 'physical-second', subject: 'Second physical subject', from_email: 'second@example.invalid' };
const aggregate = { ...first, subject: second.subject, from_email: second.from_email, message_count: 2 };

test('an exact result keeps its own metadata when the grouped list arrives later', () => {
  const threads = { [`__dl_${first.id}`]: [first], expanded: [first, second] };
  assert.equal(resolvePresentedMessage(first.id, 'single', [], threads), first);
  assert.equal(resolvePresentedMessage(first.id, 'single', [aggregate], threads), first);
  assert.equal(resolvePresentedMessage(first.id, 'auto', [aggregate], threads), aggregate, 'ordinary grouped selection keeps the list projection');
});

test('a later exact selection cannot inherit the earlier physical record', () => {
  const threads = { [`__dl_${first.id}`]: [first], [`__dl_${second.id}`]: [second] };
  assert.equal(resolvePresentedMessage(second.id, 'single', [aggregate], threads), second);
  assert.equal(resolvePresentedMessage('missing-id', 'single', [aggregate], threads), undefined);
});

test('only a matching exact slot outranks fresh list metadata', () => {
  const updated = { ...first, subject: 'Updated physical subject' };
  assert.equal(resolvePresentedMessage(first.id, 'single', [updated], { expanded: [first] }), updated);
  assert.equal(resolvePresentedMessage(first.id, 'single', [updated], { [`__dl_${first.id}`]: [second] }), updated);
});
