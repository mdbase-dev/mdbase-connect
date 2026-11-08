## Security

- Run protected Editor publication helpers only from the workflow's main commit, authenticate the direct protocol through the SDK's bundled archive, and enforce the Sigstore certificate identity policy in Editor and SDK publication.
- Bound upload time, snapshot all previous Editor entry resources, and restore and fully verify the previous deployment after a failed or incomplete production browser smoke.
