use super::*;

pub(super) fn stage_snapshot_collection(
    resources: &SyncCollectionResources,
) -> Result<(tempfile::TempDir, mdbase::Collection), MirrorError> {
    let staging = tempfile::tempdir().map_err(|error| {
        MirrorError::new(
            "invalid_snapshot",
            format!("Could not stage authority resources: {error}"),
        )
    })?;
    for resource in &resources.documents {
        validate_portable_mirror_path(&resource.path)
            .map_err(|error| MirrorError::new("invalid_snapshot", error))?;
        if format!("sha256:{}", digest(&resource.document)) != resource.revision {
            return Err(MirrorError::new(
                "invalid_snapshot",
                format!(
                    "Resource {} revision does not match its bytes.",
                    resource.path
                ),
            ));
        }
        atomic_write(
            &safe_path(staging.path(), &resource.path)?,
            resource.document.as_bytes(),
        )?;
    }
    let collection = mdbase::Collection::open(staging.path()).map_err(|error| {
        MirrorError::new(
            "invalid_snapshot",
            format!("Authority resources do not form a valid collection: {error}"),
        )
    })?;
    let canonical = collection.snapshot().map_err(|error| {
        MirrorError::new(
            "invalid_snapshot",
            format!("Authority resources could not be canonicalized: {error}"),
        )
    })?;
    if canonical.spec_version != resources.spec_version
        || canonical.resources.len() != resources.documents.len()
    {
        return Err(MirrorError::new(
            "invalid_snapshot",
            "Authority resources are not their declared canonical collection snapshot.",
        ));
    }
    let declared = resources
        .documents
        .iter()
        .map(|resource| (resource.path.as_str(), resource))
        .collect::<BTreeMap<_, _>>();
    for resource in canonical.resources {
        let expected = declared.get(resource.path.as_str()).ok_or_else(|| {
            MirrorError::new(
                "invalid_snapshot",
                format!("Authority resource {} is not canonical.", resource.path),
            )
        })?;
        if expected.kind != resource_kind(resource.kind)
            || expected.revision != resource.revision
            || expected.document != resource.document
        {
            return Err(MirrorError::new(
                "invalid_snapshot",
                format!("Authority resource {} is not canonical.", resource.path),
            ));
        }
    }
    Ok((staging, collection))
}

fn resource_kind(kind: mdbase::runtime::CollectionSnapshotResourceKind) -> &'static str {
    match kind {
        mdbase::runtime::CollectionSnapshotResourceKind::Configuration => "configuration",
        mdbase::runtime::CollectionSnapshotResourceKind::Lock => "lock",
        mdbase::runtime::CollectionSnapshotResourceKind::Contract => "contract",
        mdbase::runtime::CollectionSnapshotResourceKind::Schema => "schema",
        mdbase::runtime::CollectionSnapshotResourceKind::Type => "type",
        mdbase::runtime::CollectionSnapshotResourceKind::View => "view",
    }
}
