//! SQLite representation of the canonical file index.
use super::*;

pub(super) fn read_indexed_files(
    connection: &Connection,
    collection_id: Uuid,
) -> Result<BTreeMap<Uuid, IndexedFile>, ConnectError> {
    query_indexed_files(
        connection,
        "collection_id = ?1 ORDER BY path_key",
        params![collection_id.to_string()],
    )
}

pub(super) fn query_indexed_files(
    connection: &Connection,
    predicate: &str,
    values: impl rusqlite::Params,
) -> Result<BTreeMap<Uuid, IndexedFile>, ConnectError> {
    // Predicates are fixed internal SQL; all request values remain bound parameters.
    let mut statement = connection.prepare(&format!(
        "SELECT file_id, path, path_key, revision, content_digest, size,
                media_type, media_class, modified_at, physical_device, physical_file
         FROM collection_files WHERE {predicate}"
    ))?;
    let rows = statement.query_map(values, |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, u64>(5)?,
            row.get::<_, Option<String>>(6)?,
            row.get::<_, String>(7)?,
            row.get::<_, String>(8)?,
            row.get::<_, Option<String>>(9)?,
            row.get::<_, Option<String>>(10)?,
        ))
    })?;
    rows.map(|row| {
        #[cfg(test)]
        crate::registry::tests::file_io::record("index_rows_loaded", 1);
        let (
            file_id,
            path,
            path_key,
            revision,
            content_digest,
            size,
            media_type,
            media_class,
            modified_at,
            physical_device,
            physical_file,
        ) = row?;
        let file_id = Uuid::parse_str(&file_id).map_err(|error| ConnectError::File {
            code: "file_index_corrupt".to_string(),
            message: format!("The local file index contains an invalid file ID: {error}"),
        })?;
        Ok((
            file_id,
            IndexedFile {
                descriptor: CollectionFileDescriptor {
                    file_id,
                    path,
                    revision,
                    content_digest,
                    size,
                    media_type,
                    media_class: parse_media_class(&media_class)?,
                    modified_at,
                },
                path_key,
                physical_identity: physical_device
                    .zip(physical_file)
                    .map(
                        |(device, file)| -> Result<PhysicalFileIdentity, ConnectError> {
                            Ok(PhysicalFileIdentity {
                                device: device.parse().map_err(|_| ConnectError::File {
                                    code: "file_index_corrupt".to_string(),
                                    message:
                                        "The local file index contains an invalid device identity."
                                            .to_string(),
                                })?,
                                file: file.parse().map_err(|_| ConnectError::File {
                                    code: "file_index_corrupt".to_string(),
                                    message:
                                        "The local file index contains an invalid file identity."
                                            .to_string(),
                                })?,
                            })
                        },
                    )
                    .transpose()?,
            },
        ))
    })
    .collect()
}

pub(super) fn persist_indexed_file(
    transaction: &Transaction<'_>,
    collection_id: Uuid,
    file: &IndexedFile,
) -> Result<(), ConnectError> {
    #[cfg(test)]
    crate::registry::tests::file_io::record("index_rows_inserted", 1);
    transaction.execute(
        "INSERT INTO collection_files
           (collection_id, file_id, path, path_key, revision, content_digest, size,
            media_type, media_class, modified_at, physical_device, physical_file)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            collection_id.to_string(),
            file.descriptor.file_id.to_string(),
            file.descriptor.path,
            file.path_key,
            file.descriptor.revision,
            file.descriptor.content_digest,
            file.descriptor.size,
            file.descriptor.media_type,
            media_class_name(file.descriptor.media_class),
            file.descriptor.modified_at,
            file.physical_identity
                .as_ref()
                .map(|identity| identity.device.to_string()),
            file.physical_identity
                .as_ref()
                .map(|identity| identity.file.to_string()),
        ],
    )?;
    Ok(())
}
