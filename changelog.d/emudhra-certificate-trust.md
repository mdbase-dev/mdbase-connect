## Security

- Update the development and hosted-provider release locks to rustls-webpki 0.103.16
  and webpki-roots 1.0.10, rejecting compromised eMudhra certificate keys and
  removing the affected roots. Pin server and MCP build/runtime images to patched
  Node 24.22.1 and refresh their system CA stores. Operators must rebuild images
  with fresh base images and without cached package-install layers, then deploy
  and verify certificate rejection using the running application HTTP clients.
