# TODOS

- Reference properties: add a force-delete / unlink workflow for mutual references across different subtrees. Today the delete guard correctly protects surviving incoming references, but two nodes that reference each other cannot be deleted one at a time unless the user first clears one reference.
