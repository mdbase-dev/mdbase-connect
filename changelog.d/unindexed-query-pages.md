## Fixed

- On a budgeted host (browser, mobile, hosted), a query whose `where` the index cannot express, such as a search of record bodies, now returns pages with a cursor once its whole answer would exceed the request budget, instead of failing with `query_budget_exceeded`. Pages follow the query's order over the index's selection of its types; `pages()` follows the cursor as before. Queries that fit the budget are answered as before.
