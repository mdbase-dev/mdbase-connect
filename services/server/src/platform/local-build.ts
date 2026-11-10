// Managed artifacts always compile false. Only the explicit build:local step
// emits the separate local literal; it is not a runtime environment selector.
export const LOCAL_REHEARSAL_BUILD: boolean = false;
