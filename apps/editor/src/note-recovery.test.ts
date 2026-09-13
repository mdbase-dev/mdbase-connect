import { expect, it } from 'vitest';
import { MdbaseConnectError } from '@mdbase-dev/connect';
import { connectFailure, connectProblem, connectSuccess } from '@mdbase-dev/connect-testing';
import { ConnectCollectionGateway } from './gateway';
import { NoteOperationCoordinator } from './note-operation-coordinator';
import { createNoteSession } from './note-session';
import type { NoteDocument } from './model';

const document: NoteDocument = {
  path: 'note.md', revision: 'r1', body: '# Note\n', types: [],
  frontmatter: {}, effectiveFrontmatter: {}, file: { path: 'note.md' }
};
const unknown = connectFailure(connectProblem('operation_outcome_unknown', 'Response lost', {
  operationOutcome: 'unknown', details: { request_id: 'original-update' }
}));
const rejected = connectFailure(connectProblem('concurrent_modification', 'Revision changed', {
  operationOutcome: 'rejected'
}));

for (const mode of ['success', 'automatic-rejection', 'deferred-rejection'] as const) {
  it(`${mode}: exact continuation settles the original pending identity`, async () => {
    let pending = false;
    let resolveNow = mode !== 'deferred-rejection';
    let updates = 0;
    const handle = {
      requestId: 'original-update', operation: 'update',
      async recover() {
        if (!resolveNow) return unknown;
        // The SDK removes durable pending records on a definitive response.
        pending = false;
        return mode === 'success' ? connectSuccess({ ...document, revision: 'r2' }) : rejected;
      }
    };
    const connection = {
      pendingMutations: () => pending ? [handle] : [],
      pendingMutation: (id: string) => pending && id === handle.requestId ? handle : null,
      async update() { updates++; pending = true; return unknown; }
    };
    const gateway = new ConnectCollectionGateway('https://connect.example');
    Object.defineProperty(gateway, 'session', { value: { connection: () => connection }, configurable: true });
    const session = createNoteSession(document, []);
    session.draft.body = 'Keep this draft';
    const coordinator = new NoteOperationCoordinator({
      update: input => gateway.update(input), recover: id => gateway.recoverNoteMutation(id),
      onSaved() {}, onChange() {}, onSaveError() {}
    });
    if (mode === 'success') {
      await coordinator.requestSave(session);
      expect(session.pendingSave).toBeUndefined();
    } else {
      if (mode === 'deferred-rejection') {
        await expect(coordinator.requestSave(session)).rejects.toMatchObject({ problem: { code: 'operation_outcome_unknown' } });
        resolveNow = true;
      }
      let error: unknown;
      try { await coordinator.requestSave(session); } catch (cause) { error = cause; }
      expect(error).toBeInstanceOf(MdbaseConnectError);
      expect(gateway.pendingNoteMutations()).toEqual([]);
      expect(updates).toBe(1);
      expect(session.draft.body).toBe('Keep this draft');
      expect((error as MdbaseConnectError).problem.code).toBe('concurrent_modification');
      expect(session.pendingSave).toBeUndefined();
      expect(session.saveState).toBe('conflict');
    }
  });
}

it.each([
  ['still unknown', new MdbaseConnectError(unknown.problem)],
  ['probe not sent', new MdbaseConnectError(connectProblem('temporarily_unavailable', 'Probe unavailable', { operationOutcome: 'not_sent' }))],
  ['unstructured failure', new Error('Offline')]
])('retains the original intent when recovery is %s', async (_name, failure) => {
  let updates = 0;
  const session = createNoteSession(document, []);
  session.draft.body = 'Original accepted intent';
  const coordinator = new NoteOperationCoordinator({
    async update() { updates++; throw new MdbaseConnectError(unknown.problem); },
    async recover() { throw failure; },
    onSaved() {}, onChange() {}, onSaveError() {}
  });
  await expect(coordinator.requestSave(session)).rejects.toBeInstanceOf(MdbaseConnectError);
  session.draft.body = 'Newer unsent draft';
  await expect(coordinator.requestSave(session)).rejects.toBe(failure);
  expect(updates).toBe(1);
  expect(session.pendingSave).toMatchObject({ requestId: 'original-update', draft: { body: 'Original accepted intent' } });
  expect(session.draft.body).toBe('Newer unsent draft');
  expect(session.saveState).toBe('recovery');
});
