## Fixed

- Continuous npm, SDK, and Desktop release planning now follows live Connect/MCP production ancestry without bounding candidates or compatibility checks by the retired hosted-provider revision, and workspace planning loads the checked-out candidate's own package list so deleted packages on `main` cannot break planning.
