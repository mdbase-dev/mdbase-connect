import { appTimers, type ConnectAppTimersPort } from "@mdbase-dev/connect/timers";
import type { MdbaseConnection as TimerConnection } from "@mdbase-dev/connect";
function timerPort(connection: TimerConnection): ConnectAppTimersPort { return appTimers(connection); }
void timerPort;
// @ts-expect-error No generic request, bearer or grant key access.
import { request, currentToken, sign } from "@mdbase-dev/connect/timers";
void request; void currentToken; void sign;
