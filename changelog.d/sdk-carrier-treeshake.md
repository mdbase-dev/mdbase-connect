## Fixed

- Private collections open in apps built with Vite or Rollup. Rollup's default tree-shaking deleted the calls that hand a relay or WebSocket carrier's messages and close to the SDK, so the computer's handshake reply was dropped and opening never finished.
