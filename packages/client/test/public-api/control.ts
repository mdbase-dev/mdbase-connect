import { accountBackend, type AccountBackendInfo } from "@mdbase-dev/connect/control";
import type { MdbaseConnection as ControlConnection, ConnectRequestOptions as ControlRequestOptions } from "@mdbase-dev/connect";
function beforeData(connection: ControlConnection, options: ControlRequestOptions): Promise<AccountBackendInfo> {
  return accountBackend(connection, options);
}
void beforeData;
// @ts-expect-error No public generic request capability.
import { request } from "@mdbase-dev/connect/control";
// @ts-expect-error No public signing capability or credential getter.
import { signAuthorityRequest, currentToken } from "@mdbase-dev/connect/control";
void request; void signAuthorityRequest; void currentToken;
