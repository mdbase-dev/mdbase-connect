const PENDING_OPERATIONS_PER_GRANT = 8;
const PENDING_OPERATIONS_PER_CONNECTOR = 16;
const PENDING_OPERATIONS_PROCESS = 256;
const PENDING_OPERATION_BYTES_PER_GRANT = 8 * 1024 * 1024;
const PENDING_OPERATION_BYTES_PER_CONNECTOR = 16 * 1024 * 1024;
const PENDING_OPERATION_BYTES_PROCESS = 64 * 1024 * 1024;

export interface PendingOperationAdmission {
  connectorId?: string;
  grantId?: string;
  requestBytes?: number;
}

export function grantIdFromMessage(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const grantId = (message as { grant_id?: unknown }).grant_id;
  return typeof grantId === "string" && grantId.length > 0 ? grantId : undefined;
}

export function hasPendingOperationCapacity(
  pending: Iterable<PendingOperationAdmission>,
  connectorId: string,
  grantId: string,
  requestBytes: number
): boolean {
  let grantCount = 0;
  let connectorCount = 0;
  let processCount = 0;
  let grantBytes = 0;
  let connectorBytes = 0;
  let processBytes = 0;
  for (const request of pending) {
    if (request.grantId === undefined) continue;
    const bytes = request.requestBytes ?? 0;
    processCount += 1;
    processBytes += bytes;
    if (request.connectorId !== connectorId) continue;
    connectorCount += 1;
    connectorBytes += bytes;
    if (request.grantId !== grantId) continue;
    grantCount += 1;
    grantBytes += bytes;
  }
  return grantCount < PENDING_OPERATIONS_PER_GRANT
    && connectorCount < PENDING_OPERATIONS_PER_CONNECTOR
    && processCount < PENDING_OPERATIONS_PROCESS
    && grantBytes + requestBytes <= PENDING_OPERATION_BYTES_PER_GRANT
    && connectorBytes + requestBytes <= PENDING_OPERATION_BYTES_PER_CONNECTOR
    && processBytes + requestBytes <= PENDING_OPERATION_BYTES_PROCESS;
}
