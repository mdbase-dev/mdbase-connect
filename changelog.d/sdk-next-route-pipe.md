## Added

- An opt-in `@mdbase-dev/connect/next` entry: `mdbaseNext(connection)` returns `route` and `openPipe` for mdbase-next collections. The retained access token stays inside the client; `openPipe` re-validates the route, authenticates the relay pipe and returns a byte duplex for the mdbase-next SDK's Noise session. The classic browser bundle is unchanged.
