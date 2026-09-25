import { expect, it } from 'vitest';
import { MdbaseConnectError } from '@mdbase-dev/connect';
import { connectFailure, connectProblem, connectSuccess } from '@mdbase-dev/connect-testing';
import { ConnectCollectionGateway } from './gateway';
import { NoteSession, noteRecordAdapter } from './note-session';
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

// The editor's gateway and note session together: an interrupted autosave is
// settled only through the SDK's durable handle, never by a second update.
for (const mode of ['success', 'rejection', 'deferred-rejection', 'not-sent', 'deferred-not-sent', 'unmarked', 'probe-rejection'] as const) {
  it(`${mode}: exact continuation settles the original pending identity`, async () => {
    let pending = false;
    let resolveNow = !mode.startsWith('deferred');
    const failure = mode.endsWith('not-sent')
      ? connectFailure(connectProblem('temporarily_unavailable', 'Not admitted', { operationOutcome: 'not_sent' }))
      : mode === 'unmarked' ? connectFailure(connectProblem('not_authorized', 'Grant expired')) : rejected;
    let updates = 0;
    const handle = {
      requestId: 'original-update', operation: 'update',
      async recover() {
        if (!resolveNow) return unknown;
        if (mode === 'probe-rejection') return rejected;
        // The SDK removes durable pending records on a definitive response.
        pending = false;
        return mode === 'success' ? connectSuccess({ ...document, revision: 'r2', body: '# Note\n\nKeep this draft' }) : failure;
      }
    };
    const connection = {
      pendingMutations: () => pending ? [handle] : [],
      pendingMutation: (id: string) => pending && id === handle.requestId ? handle : null,
      async update() { updates++; pending = true; return unknown; },
      async read() { return connectSuccess(document); }
    };
    const gateway = new ConnectCollectionGateway('https://connect.example');
    Object.defineProperty(gateway, 'session', { value: { connection: () => connection }, configurable: true });
    const session = new NoteSession(document, () => [], noteRecordAdapter(gateway));
    session.edit({ ...session.draft, body: 'Keep this draft' });
    await expect(session.record.save()).rejects.toMatchObject({ problem: { code: 'operation_outcome_unknown' } });
    expect(session.pendingRequestId).toBe('original-update');
    expect(session.saveState).toBe('recovery');
    if (mode.startsWith('deferred')) {
      await expect(session.record.save()).rejects.toMatchObject({ problem: { code: 'operation_outcome_unknown' } });
      expect(session.pendingRequestId).toBe('original-update');
      resolveNow = true;
    }
    let error: unknown;
    try { await session.record.save(); } catch (cause) { error = cause; }
    expect(updates).toBe(1);
    expect(session.draft.body).toBe('Keep this draft');
    if (mode === 'probe-rejection') {
      expect(pending).toBe(true);
      expect(session.pendingRequestId).toBe('original-update');
      expect(session.saveState).toBe('recovery');
    } else if (mode === 'success') {
      expect(error).toBeUndefined();
      expect(session.pendingRequestId).toBeUndefined();
      expect(session.saveState).toBe('saved');
    } else {
      expect(error).toBeInstanceOf(MdbaseConnectError);
      expect((error as MdbaseConnectError).problem.code).toBe(failure.problem.code);
      expect(gateway.pendingNoteMutations()).toEqual([]);
      expect(session.pendingRequestId).toBeUndefined();
      expect(session.saveState).toBe('error');
    }
  });
}
