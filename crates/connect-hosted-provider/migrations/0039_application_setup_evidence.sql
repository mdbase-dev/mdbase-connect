-- Retained application-signed setup evidence; never supplied by an operation caller.
ALTER TABLE hosted_provider_replicas ADD COLUMN application_setup_evidence jsonb;
