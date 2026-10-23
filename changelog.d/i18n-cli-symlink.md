## Fixed

- Run `mdbase-i18n` checks through npm-style `.bin` symlinks instead of silently succeeding without validation. A dedicated bin invokes the CLI for every command; packed-consumer tests reject incomplete catalogues.
