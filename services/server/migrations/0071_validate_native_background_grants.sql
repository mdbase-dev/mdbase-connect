-- mdbase:native-background-grant-hooks:v1
-- mdbase:query-timeout-ms 600000
-- Validate the existing rows separately from the short exclusive FK swaps.
-- NOT VALID already checks new writes; validation does not exclude readers/writers.
ALTER TABLE next_timers VALIDATE CONSTRAINT next_timers_background_grant_fkey;
ALTER TABLE next_timer_events VALIDATE CONSTRAINT next_timer_events_background_grant_fkey;
ALTER TABLE next_timer_namespace_intents VALIDATE CONSTRAINT next_timer_namespace_intents_background_grant_fkey;
ALTER TABLE push_channels VALIDATE CONSTRAINT push_channels_background_grant_fkey;
ALTER TABLE notification_subscriptions VALIDATE CONSTRAINT notification_subscriptions_background_grant_fkey;
ALTER TABLE notification_signals VALIDATE CONSTRAINT notification_signals_background_grant_fkey;
