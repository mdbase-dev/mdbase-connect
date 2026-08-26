use super::*;

trait CollectionDescriptionSource {
    fn spec_profile(&self) -> SpecProfile;
    fn types(&self) -> &HashMap<String, mdbase::types::schema::TypeDef>;
    fn list_data_contracts(&self) -> Vec<mdbase::data_contracts::DataContractDefinition>;
    fn get_data_contract_implementations(
        &self,
        contract: &str,
        version: &str,
    ) -> Vec<mdbase::data_contracts::DataContractImplementationDescriptor>;
}

impl CollectionDescriptionSource for Collection {
    fn spec_profile(&self) -> SpecProfile {
        Collection::spec_profile(self)
    }

    fn types(&self) -> &HashMap<String, mdbase::types::schema::TypeDef> {
        Collection::types(self)
    }

    fn list_data_contracts(&self) -> Vec<mdbase::data_contracts::DataContractDefinition> {
        Collection::list_data_contracts(self)
    }

    fn get_data_contract_implementations(
        &self,
        contract: &str,
        version: &str,
    ) -> Vec<mdbase::data_contracts::DataContractImplementationDescriptor> {
        Collection::get_data_contract_implementations(self, contract, version)
    }
}

impl CollectionDescriptionSource for mdbase::CollectionResources {
    fn spec_profile(&self) -> SpecProfile {
        self.spec_profile()
    }

    fn types(&self) -> &HashMap<String, mdbase::types::schema::TypeDef> {
        self.types()
    }

    fn list_data_contracts(&self) -> Vec<mdbase::data_contracts::DataContractDefinition> {
        self.list_data_contracts()
    }

    fn get_data_contract_implementations(
        &self,
        contract: &str,
        version: &str,
    ) -> Vec<mdbase::data_contracts::DataContractImplementationDescriptor> {
        self.get_data_contract_implementations(contract, version)
    }
}

fn open_registered_resources(
    registered: &CollectionSummary,
) -> Result<mdbase::CollectionResources, ConnectError> {
    let path = Path::new(&registered.path);
    assert_local_authority_folder(path)?;
    mdbase::CollectionResources::open(path).map_err(|error| {
        if registered.spec_version.starts_with("0.3") {
            let report = mdbase::v03::inspect_collection(path);
            if !report.valid {
                return ConnectError::invalid_collection(report.diagnostics);
            }
        }
        ConnectError::CollectionOpen(format!("resource catalog is invalid: {error}"))
    })
}

fn contract_descriptors(
    source: &impl CollectionDescriptionSource,
) -> Vec<CollectionContractDescriptor> {
    let mut contracts = source
        .list_data_contracts()
        .into_iter()
        .filter_map(|definition| {
            let implementations = source
                .get_data_contract_implementations(&definition.id, &definition.version)
                .into_iter()
                .map(|implementation| {
                    mdbase_connect_protocol::CollectionContractImplementationDescriptor {
                        type_name: implementation.type_name,
                        type_version: implementation.type_version,
                        type_path: implementation.source_path,
                        digest: implementation.implementation_digest,
                        fields: implementation.fields,
                        binding: implementation.binding,
                    }
                })
                .collect::<Vec<_>>();
            (!implementations.is_empty()).then_some(CollectionContractDescriptor {
                implementations,
                contract_type: definition.contract_type,
                id: definition.id,
                version: definition.version,
                digest: definition.digest,
                schema: definition
                    .record_schema
                    .expect("record implementations require record_schema"),
                binding_schema: definition.binding_schema,
            })
        })
        .collect::<Vec<_>>();
    contracts.sort_by(|left, right| (&left.id, &left.version).cmp(&(&right.id, &right.version)));
    contracts
}

impl CollectionRegistry {
    pub fn describe(&self, id: Uuid) -> Result<CollectionDescription, ConnectError> {
        let registered = self.get(id)?;
        self.describe_registered(&registered)
    }

    pub(super) fn describe_registered(
        &self,
        registered: &CollectionSummary,
    ) -> Result<CollectionDescription, ConnectError> {
        let resources = open_registered_resources(registered)?;
        self.describe_source(registered, &resources)
            .map_err(|error| classify_collection_error(registered, error))
    }

    pub(super) fn describe_contracts_registered(
        &self,
        registered: &CollectionSummary,
    ) -> Result<Vec<CollectionContractDescriptor>, ConnectError> {
        let resources = open_registered_resources(registered)?;
        Ok(contract_descriptors(&resources))
    }

    pub(super) fn describe_loaded(
        &self,
        registered: &CollectionSummary,
        collection: &Collection,
    ) -> Result<CollectionDescription, ConnectError> {
        self.describe_source(registered, collection)
    }

    fn describe_source(
        &self,
        registered: &CollectionSummary,
        collection: &impl CollectionDescriptionSource,
    ) -> Result<CollectionDescription, ConnectError> {
        let mut types = Vec::new();
        let mut contracts = Vec::new();
        let mut configuration = None;
        if collection.spec_profile() == SpecProfile::V03 {
            let path = Path::new(&registered.path);
            let raw_configuration = mdbase::v03::inspect_configuration(path)
                .map_err(ConnectError::invalid_collection)?;
            configuration = portable_configuration(&raw_configuration);
            for type_definition in collection.types().values() {
                let Some(frontmatter) = type_definition.v03_frontmatter.as_ref() else {
                    continue;
                };
                let Some(type_path) = type_definition.source_path.as_ref() else {
                    continue;
                };
                let Some(schema) = type_definition.json_schema.as_ref() else {
                    continue;
                };
                let collection_metadata = frontmatter.get("collection").cloned();
                let lifecycle = frontmatter.get("lifecycle").cloned();
                let extensions = frontmatter
                    .as_object()
                    .into_iter()
                    .flatten()
                    .filter(|(key, _)| key.starts_with("x-"))
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect::<serde_json::Map<_, _>>();
                types.push(CollectionTypeDescriptor {
                    name: frontmatter
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or(&type_definition.name)
                        .to_string(),
                    version: type_definition.version,
                    description: type_definition.description.clone(),
                    revision: type_definition.source_revision.clone(),
                    path: Some(type_path.clone()),
                    definition: frontmatter.as_object().cloned().map(Value::Object),
                    schema: schema.clone(),
                    collection: collection_metadata,
                    lifecycle,
                    extensions,
                });
            }
            contracts = contract_descriptors(collection);
        }
        types.sort_by(|left, right| left.name.cmp(&right.name));
        contracts
            .sort_by(|left, right| (&left.id, &left.version).cmp(&(&right.id, &right.version)));
        Ok(CollectionDescription {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            collection_id: registered.id,
            display_name: registered.display_name.clone(),
            spec_version: registered.spec_version.clone(),
            operations: supported_operations(collection.spec_profile())
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            change_cursor: self.current_change_cursor(registered.id)?,
            types,
            contracts,
            configuration,
        })
    }

    pub fn append_change(
        &self,
        collection_id: Uuid,
        event: &mdbase::watch::WatchEvent,
    ) -> Result<u64, ConnectError> {
        self.append_changes(collection_id, std::slice::from_ref(event))?
            .into_iter()
            .next()
            .ok_or_else(|| ConnectError::InvalidInput("A collection change is required.".into()))
    }

    pub fn append_changes(
        &self,
        collection_id: Uuid,
        events: &[mdbase::watch::WatchEvent],
    ) -> Result<Vec<u64>, ConnectError> {
        self.get(collection_id)?;
        if events.is_empty() {
            return Ok(Vec::new());
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        Self::mark_file_inventory_dirty_in(
            &transaction,
            collection_id,
            u64::try_from(events.len()).unwrap_or(u64::MAX),
        )?;
        let mut cursor: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(cursor), 0) FROM collection_changes WHERE collection_id = ?1",
            [collection_id.to_string()],
            |row| row.get(0),
        )?;
        let mut cursors = Vec::with_capacity(events.len());
        for event in events {
            cursor = cursor.checked_add(1).ok_or_else(|| {
                ConnectError::CollectionOpen("collection change cursor exhausted".into())
            })?;
            let mut payload = event.payload.clone();
            if let Some(object) = payload.as_object_mut() {
                object.remove("before");
                object.remove("after");
            }
            transaction.execute(
                "INSERT INTO collection_changes
                   (collection_id, cursor, event_type, occurred_at, payload)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    collection_id.to_string(),
                    cursor,
                    event.event_type,
                    event.occurred_at,
                    serde_json::to_string(&payload)?,
                ],
            )?;
            cursors.push(cursor as u64);
        }
        transaction.execute(
            "DELETE FROM collection_changes WHERE collection_id = ?1 AND cursor <= ?2",
            params![collection_id.to_string(), cursor.saturating_sub(2_000)],
        )?;
        transaction.commit()?;
        Ok(cursors)
    }

    pub(super) fn refresh_summary_metadata(
        &self,
        collection: &mut CollectionSummary,
    ) -> Result<(), ConnectError> {
        let path = Path::new(&collection.path);
        let metadata = read_collection_metadata(path)?;
        let display_name = collection_display_name(&metadata, path);
        let description = normalized_optional(metadata.description);
        if collection.display_name != display_name
            || collection.description != description
            || collection.spec_version != metadata.spec_version
        {
            collection.display_name = display_name;
            collection.description = description;
            collection.spec_version = metadata.spec_version;
            self.connection()?.execute(
                "UPDATE collections
                 SET display_name = ?2, description = ?3, spec_version = ?4,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![
                    collection.id.to_string(),
                    collection.display_name,
                    collection.description,
                    collection.spec_version
                ],
            )?;
        }
        Ok(())
    }

    pub fn changes(
        &self,
        collection_id: Uuid,
        input: &Value,
    ) -> Result<CollectionChangesPage, ConnectError> {
        self.get(collection_id)?;
        let current = self.current_change_cursor(collection_id)?;
        let Some(after) = input.get("after").and_then(Value::as_u64) else {
            return Ok(CollectionChangesPage {
                events: Vec::new(),
                cursor: current,
                has_more: false,
                reset: false,
            });
        };
        let limit = input
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(100)
            .clamp(1, 500) as usize;
        let connection = self.connection()?;
        let earliest = connection
            .query_row(
                "SELECT MIN(cursor) FROM collection_changes WHERE collection_id = ?1",
                [collection_id.to_string()],
                |row| row.get::<_, Option<u64>>(0),
            )?
            .unwrap_or(current.saturating_add(1));
        if after.saturating_add(1) < earliest {
            return Ok(CollectionChangesPage {
                events: Vec::new(),
                cursor: current,
                has_more: false,
                reset: true,
            });
        }
        let mut statement = connection.prepare(
            "SELECT cursor, event_type, occurred_at, payload
             FROM collection_changes
             WHERE collection_id = ?1 AND cursor > ?2
             ORDER BY cursor ASC LIMIT ?3",
        )?;
        let rows = statement.query_map(
            params![collection_id.to_string(), after, (limit + 1) as u64],
            |row| {
                Ok((
                    row.get::<_, u64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )?;
        let mut events = rows
            .map(|row| {
                let (cursor, event_type, occurred_at, payload) = row?;
                Ok(CollectionChange {
                    cursor,
                    event_type,
                    occurred_at,
                    payload: serde_json::from_str(&payload)?,
                })
            })
            .collect::<Result<Vec<_>, ConnectError>>()?;
        let has_more = events.len() > limit;
        events.truncate(limit);
        let cursor = events.last().map(|event| event.cursor).unwrap_or(after);
        Ok(CollectionChangesPage {
            events,
            cursor,
            has_more,
            reset: false,
        })
    }

    fn current_change_cursor(&self, collection_id: Uuid) -> Result<u64, ConnectError> {
        let cursor = self.connection()?.query_row(
            "SELECT COALESCE(MAX(cursor), 0) FROM collection_changes WHERE collection_id = ?1",
            [collection_id.to_string()],
            |row| row.get::<_, u64>(0),
        )?;
        Ok(cursor)
    }
}

fn portable_configuration(configuration: &Value) -> Option<Value> {
    let source = configuration.as_object()?;
    let mut result = serde_json::Map::new();
    if let Some(spec_version) = source.get("spec_version") {
        result.insert("spec_version".to_string(), spec_version.clone());
    }
    if let Some(settings) = select_configuration_fields(
        source.get("settings"),
        &[
            "types_folder",
            "record_extensions",
            "validation",
            "explicit_type_keys",
            "id_field",
            "include_subfolders",
            "exclude",
        ],
    ) {
        result.insert("settings".to_string(), settings);
    }
    if let Some(runtime) = select_configuration_fields(
        source.get("runtime"),
        &["profile_version", "enabled", "contract_mode", "policy"],
    ) {
        result.insert("runtime".to_string(), runtime);
    }
    Some(Value::Object(result))
}

fn select_configuration_fields(value: Option<&Value>, fields: &[&str]) -> Option<Value> {
    let source = value?.as_object()?;
    let selected = fields
        .iter()
        .filter_map(|field| {
            source
                .get(*field)
                .map(|value| ((*field).to_string(), value.clone()))
        })
        .collect::<serde_json::Map<_, _>>();
    Some(Value::Object(selected))
}
