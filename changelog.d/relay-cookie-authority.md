## Fixed

- Fixed Private collection relay connections being rejected when a browser also sends its Connect session cookie, including same-site app deployments. The client relay still requires its own valid grant credentials; account and management requests retain their cross-origin protections.
