## Fixed

- Hosted replicas resume record-index repairs across wakes instead of rewriting the collection on every retry. Their log cache no longer writes unused body and field search projections.
