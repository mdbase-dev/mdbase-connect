## Fixed

- App access to synced collections (cloud copy and Private) is no longer revoked by the periodic application check when the app's declaration still allows it. Before, every such approval was revoked within about six hours with the reason `application_manifest_change`, and the app had to be approved again.
