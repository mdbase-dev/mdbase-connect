## Fixed

- Say why collection setup is refused. When setup would leave a definition already in the collection invalid, such as a renamed note type that still implements an older contract version, the error now names the cause and that definition's path instead of only "the complete atomic setup plan cannot be admitted". Apps no longer tell the collection's owner to ask its owner: the message says nothing was changed and offers Try again after the definition is updated.
