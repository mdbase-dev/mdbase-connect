## Fixed

- An app that declares its application ID now connects after its manifest changes: the SDK accepts the new ID Connect registers for the changed manifest when every registration check matches the manifest it sent, and keeps the app's declared local storage names.
