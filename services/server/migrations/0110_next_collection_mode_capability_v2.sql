-- Historical mode_switch_advertised bits may come from collection_mode_switch_v1
-- clients predating late-rekey acceptance after an abandoned Private switch.
-- Reset them so arming requires a fresh collection_mode_switch_v2 advertisement.
UPDATE next_devices SET mode_switch_advertised = false WHERE mode_switch_advertised;
