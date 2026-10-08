# 2026-10-08 — appserver: immutable log grant identity

Connect's stable OAuth/control grant ID and the replica's single-use log grant UUID are distinct. Next route/switching discovery returns the log UUID as `grant`, plus `authorization_grant` for the stable control reference. Narrowing queues revoke+new grant atomically and rotates the discovery identity; Noise clients must rediscover/reconnect. Revoke and token storage still use the stable Connect ID.

Private device approval reports sign the current **log** UUID. Report lookup can translate the current log UUID or stable control reference; a superseded log UUID does not resolve. The next-device feed and relay admission likewise use only the active binding. Hosted Noise/session policy checks already use the actual log identity (hostedw ACK).

Affected: clients (SDK/Connect client, Reader and Journals), hostedw, daemon/private approval UI. Only exactly representable v2 record+file capability unions are issued; separate file/record approvals are never broadened. Full lifecycle, refusal and testing details: `../../next-grant-policy.md`.
