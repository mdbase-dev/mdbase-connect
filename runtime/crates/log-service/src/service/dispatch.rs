//! Method dispatch and budget-scoped request views.

use super::*;

impl<B: Backend, O: ObjectStore> Service<B, O> {
    /// A request view sharing backend/store/cache handles, never their counters.
    /// Projection decoders invoked by nested backend calls use this same budget.
    pub(crate) fn scoped(&self, budget: &Budget) -> Service<BudgetBackend<B>, O> {
        Service {
            backend: Arc::new(BudgetBackend {
                inner: self.backend.clone(),
                budget: budget.clone(),
            }),
            objects: self.objects.clone(),
            config: self.config.clone(),
            buckets: self.buckets.clone(),
            creds: self.creds.clone(),
            regions: self.regions.clone(),
        }
    }

    /// Dispatch a durable method by name. Connection-level methods (`hello`,
    /// `subscribe`, streams) are handled by [`crate::session`].
    pub async fn call(
        &self,
        principal: &Principal,
        method: &str,
        params: &Cbor,
        now: i64,
    ) -> Result<Outcome> {
        self.call_with_budget(principal, method, params, now, &Budget::default())
            .await
    }

    /// Dispatch with the budget used for frame and token decoding.
    pub async fn call_with_budget(
        &self,
        principal: &Principal,
        method: &str,
        params: &Cbor,
        now: i64,
        budget: &Budget,
    ) -> Result<Outcome> {
        self.scoped(budget)
            .dispatch_with_budget(principal, method, params, now, budget)
            .await
    }

    async fn dispatch_with_budget(
        &self,
        principal: &Principal,
        method: &str,
        params: &Cbor,
        now: i64,
        budget: &Budget,
    ) -> Result<Outcome> {
        macro_rules! p {
            ($t:ty) => {
                <$t>::from_cbor(params).map_err(bad_params)?
            };
        }
        self.check_credentials(principal, now, false).await?;
        match method {
            "revoke_device_credentials" => {
                self.revoke_device_credentials(principal, params, now).await
            }
            "append" => {
                self.append_with_budget(principal, p!(AppendParams), now, budget)
                    .await
            }
            "read" => Ok(Outcome::plain(
                self.read(principal, p!(ReadParams), now).await?.to_cbor(),
            )),
            "head" => Ok(Outcome::plain(
                self.head(principal, &p!(HeadParams).collection)
                    .await?
                    .to_cbor(),
            )),
            "put_object" => Ok(Outcome::plain(
                self.put_object_with_budget(principal, p!(PutObjectParams), now, budget)
                    .await?
                    .to_cbor(),
            )),
            "commit_object" => {
                let ok = self
                    .commit_object_with_budget(principal, p!(CommitObjectParams), now, budget)
                    .await?;
                Ok(Outcome::plain(map(vec![(0, Cbor::Bool(ok))])))
            }
            "get_object" => Ok(Outcome::plain(
                self.get_object(principal, p!(GetObjectParams), now)
                    .await?
                    .to_cbor(),
            )),
            "has_objects" => Ok(Outcome::plain(
                self.has_objects(principal, p!(HasObjectsParams))
                    .await?
                    .to_cbor(),
            )),
            "put_snapshot" => {
                let ok = self
                    .put_snapshot_with_budget(principal, p!(PutSnapshotParams), now, budget)
                    .await?;
                Ok(Outcome::plain(map(vec![(0, Cbor::Bool(ok))])))
            }
            "get_snapshot" => {
                let c = uuid_field(params, 0)?;
                Ok(Outcome::plain(
                    self.get_snapshot(principal, &c).await?.to_cbor(),
                ))
            }
            "endorse_snapshot" => {
                let ok = self
                    .endorse_snapshot(principal, p!(EndorseSnapshotParams), now)
                    .await?;
                Ok(Outcome::plain(map(vec![(0, Cbor::Bool(ok))])))
            }
            // §12 administrative API (control plane only).
            "create_log" => self.create_log(principal, params, now, budget).await,
            "set_quota" => self.set_quota(principal, params).await,
            "set_file_headroom" => self.set_file_headroom(principal, params).await,
            "storage_status" => self.storage_status(principal, params).await,
            "delete_log" => self.delete_log(principal, params).await,
            "log_terminal_status" => self.log_terminal_status(principal, params).await,
            "export" => self.export(principal, params).await,
            "export_objects" => self.export_objects(principal, params).await,
            "import" => self.import(principal, params, now, budget).await,
            "import_object" => self.import_object(principal, params, now, budget).await,
            "import_snapshot" => self.import_snapshot(principal, params).await,
            // Background maintenance, exposed for hosts' schedulers and tests.
            "compact" => {
                let c = uuid_field(params, 0)?;
                self.require_cp(principal)?;
                let r = self.compact(&c, now).await?;
                Ok(Outcome::plain(map(vec![(0, Cbor::Uint(r))])))
            }
            "gc" => {
                let c = uuid_field(params, 0)?;
                self.require_cp(principal)?;
                let n = self.gc(&c, now).await?;
                Ok(Outcome::plain(map(vec![(0, Cbor::Uint(n))])))
            }
            _ => Err(ServiceError::invalid("method").msg(format!("unknown method {method}"))),
        }
    }
}
