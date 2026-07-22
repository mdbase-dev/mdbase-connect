export interface ApplicationAccessGrant {
  application_id: string;
  application_name: string;
  collection_id: string;
  collection_name: string;
  created_at: string;
}

export interface ApplicationAccessGroup<Grant extends ApplicationAccessGrant> {
  applicationId: string;
  applicationName: string;
  collectionCount: number;
  grants: Grant[];
}

export function groupApplicationAccess<Grant extends ApplicationAccessGrant>(
  grants: readonly Grant[]
): ApplicationAccessGroup<Grant>[] {
  const groups = new Map<string, ApplicationAccessGroup<Grant>>();

  for (const grant of grants) {
    const current = groups.get(grant.application_id);
    if (current) {
      current.grants.push(grant);
      continue;
    }
    groups.set(grant.application_id, {
      applicationId: grant.application_id,
      applicationName: grant.application_name,
      collectionCount: 0,
      grants: [grant]
    });
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      collectionCount: new Set(group.grants.map((grant) => grant.collection_id)).size,
      grants: [...group.grants].sort(compareGrants)
    }))
    .sort((left, right) => compareText(left.applicationName, right.applicationName));
}

function compareGrants<Grant extends ApplicationAccessGrant>(left: Grant, right: Grant): number {
  return compareText(left.collection_name, right.collection_name)
    || right.created_at.localeCompare(left.created_at);
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}
