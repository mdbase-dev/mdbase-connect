## Fixed

- SDK file reads wait for the hosted replica's attachment region when another transfer holds it, instead of failing with "hosted attachment region is busy", and an aborted read now frees the region immediately rather than after a minute.
