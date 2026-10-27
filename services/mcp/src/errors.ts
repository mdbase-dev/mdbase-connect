export class GatewayOperationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
  }

  /** The connection's grant must be approved again; tool results carry a re-approval link. */
  static reconnectRequired(connection: { id: string; display_name: string }): GatewayOperationError {
    return new GatewayOperationError("reconnect_required", `${connection.display_name} needs to be approved again for the updated mdbase.`, { connection_id: connection.id });
  }
}
