## Fixed

- Count only the values a contract maps against a contract query's 1 MiB page budget. Each record's whole frontmatter was counted once per mapped field, so a page of 128 ordinary records (about 1.5 KB of frontmatter, 14 mapped fields) was refused with `too_large` / `contract_projection_budget`, and so was any single record over about 80 KB. Apps such as Writer could not load a Reader library of that shape.
